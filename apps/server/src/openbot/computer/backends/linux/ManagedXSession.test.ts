import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  INSTALLED_TOOL_PATHS,
  makeFakeHost,
  XDPYINFO_OUTPUT,
  type FakeHost,
  type FakeProcess,
  type SpawnedCommand,
} from "./linuxHost.testkit.ts";
import {
  collectStderr,
  startManagedXSession,
  type ManagedXSessionSpec,
} from "./ManagedXSession.ts";
import { NO_LINUX_TOOLS } from "./LinuxTools.ts";

const BASE_ENVIRONMENT = { PATH: "/usr/bin", HOME: "/home/agent" };
const encoder = new TextEncoder();

/** Answers Xvfb as a long-running child that reports the display it claimed on
    stdout, openbox as a long-running child, and xdpyinfo from a script of
    successive replies so readiness can be delayed. */
function host(options: {
  readonly xdpyinfo: ReadonlyArray<FakeProcess>;
  readonly xvfb?: FakeProcess;
  readonly openbox?: FakeProcess;
}): FakeHost {
  let probes = 0;
  return makeFakeHost((command: SpawnedCommand) => {
    if (command.command === INSTALLED_TOOL_PATHS.xdpyinfo) {
      const reply = options.xdpyinfo[Math.min(probes, options.xdpyinfo.length - 1)];
      probes += 1;
      return reply ?? { exitCode: 1 };
    }
    if (command.command === INSTALLED_TOOL_PATHS.Xvfb) {
      return options.xvfb ?? { runsUntilKilled: true, stdout: "60\n" };
    }
    if (command.command === INSTALLED_TOOL_PATHS.openbox) {
      return options.openbox ?? { runsUntilKilled: true };
    }
    return { runsUntilKilled: true };
  });
}

const start = (
  fake: FakeHost,
  spec: ManagedXSessionSpec = {},
  options?: { readonly taken?: ReadonlySet<number> },
) =>
  startManagedXSession(
    {
      spawner: fake.spawner,
      tools: INSTALLED_TOOL_PATHS,
      baseEnvironment: BASE_ENVIRONMENT,
    },
    spec,
    options?.taken ?? new Set(),
  );

const READY = { stdout: XDPYINFO_OUTPUT(1600, 1000), exitCode: 0 } satisfies FakeProcess;
const NOT_READY = { exitCode: 1 } satisfies FakeProcess;

describe("collectStderr", () => {
  it.effect("keeps a bounded prefix of a chatty child instead of the whole stream", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make("");
      const chunks = Array.from({ length: 400 }, () => encoder.encode("openbox: warning\n"));
      yield* collectStderr(Stream.fromIterable(chunks), ref);
      const collected = yield* Ref.get(ref);

      expect(collected.length).toBe(4_096);
      expect(collected.startsWith("openbox: warning\n")).toBe(true);
    }),
  );
});

describe("startManagedXSession", () => {
  it.effect("lets Xvfb pick the display, waits for it, then starts the window manager", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // The window manager settle is the only wait left once X answers.
      yield* TestClock.adjust(Duration.millis(400));
      const session = yield* Fiber.join(started);

      expect(session.display).toBe(":60");
      expect(session.displayNumber).toBe(60);
      expect(session.widthPx).toBe(1600);
      expect(session.heightPx).toBe(1000);
      expect(fake.commandLines()).toEqual([
        "/usr/bin/Xvfb -displayfd 1 -screen 0 1600x1000x24 +extension GLX +extension RANDR +extension RENDER -dpi 96 -noreset -nolisten tcp",
        "/usr/bin/xdpyinfo",
        "/usr/bin/openbox",
      ]);
      // Xvfb is started before there is a display to address, so only the
      // clients that follow it carry one.
      expect(fake.records[0]?.env.DISPLAY).toBeUndefined();
      expect(fake.records[1]?.env.DISPLAY).toBe(":60");
      expect(fake.records[2]?.env.DISPLAY).toBe(":60");
    }),
  );

  it.effect("uses the requested size and the display number Xvfb reported", () =>
    Effect.gen(function* () {
      const fake = host({
        xdpyinfo: [{ stdout: XDPYINFO_OUTPUT(1280, 720), exitCode: 0 }],
        xvfb: { runsUntilKilled: true, stdout: "73\n" },
      });
      const started = yield* start(fake, {
        widthPx: 1280,
        heightPx: 720,
        name: "Browser",
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(400));
      const session = yield* Fiber.join(started);

      expect(session.display).toBe(":73");
      expect(session.name).toBe("Browser");
      expect(fake.commandLines()[0]).toContain("-displayfd 1 -screen 0 1280x720x24");
    }),
  );

  it.effect("polls the display until it answers rather than assuming it is up", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [NOT_READY, NOT_READY, READY] });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(200));
      yield* TestClock.adjust(Duration.millis(200));
      yield* TestClock.adjust(Duration.millis(400));
      const session = yield* Fiber.join(started);

      expect(session.display).toBe(":60");
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.xdpyinfo)).toHaveLength(3);
    }),
  );

  it.effect("gives up after the readiness timeout and leaves nothing running", () =>
    Effect.gen(function* () {
      const fake = host({
        xdpyinfo: [{ exitCode: 1, stderr: "unable to open display" }],
        xvfb: {
          runsUntilKilled: true,
          stdout: "60\n",
          stderr: "Cannot establish any listening sockets",
        },
      });
      const started = yield* start(fake).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(16));
      const failure = yield* Fiber.join(started);

      expect(failure.code).toBe("backend_unavailable");
      expect(failure.message).toContain("Xvfb :60 did not answer");
      expect(failure.message).toContain("Cannot establish any listening sockets");
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.Xvfb)[0]?.kills).toEqual(["SIGTERM"]);
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.openbox)).toHaveLength(0);
    }),
  );

  it.effect("fails with the X server's own complaint when Xvfb exits during startup", () =>
    Effect.gen(function* () {
      const fake = host({
        xdpyinfo: [NOT_READY],
        xvfb: {
          stdout: "61\n",
          exitCode: 1,
          stderr: "Fatal server error:\n(EE) Server is already active",
        },
      });
      const started = yield* start(fake).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(200));
      const failure = yield* Fiber.join(started);

      expect(failure.code).toBe("backend_unavailable");
      expect(failure.message).toContain("stopped before it");
      expect(failure.message).toContain("Fatal server error");
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.openbox)).toHaveLength(0);
    }),
  );

  it.effect("refuses a display number this server already manages", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const started = yield* start(fake, {}, { taken: new Set([60]) }).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(200));
      const failure = yield* Fiber.join(started);

      expect(failure.code).toBe("backend_unavailable");
      expect(failure.message).toContain(":60");
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.Xvfb)[0]?.kills).toEqual(["SIGTERM"]);
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.openbox)).toHaveLength(0);
    }),
  );

  it.effect("stops the X server when startup is interrupted while waiting for it", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [NOT_READY] });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(200));
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.xdpyinfo).length).toBeGreaterThan(0);

      yield* Fiber.interrupt(started);

      expect(fake.killOrder).toEqual([INSTALLED_TOOL_PATHS.Xvfb]);
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.openbox)).toHaveLength(0);
    }),
  );

  it.effect("stops both children when startup is interrupted during the settle", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // Less than the settle, so the window manager is up and startup is still
      // waiting for it when the interrupt lands.
      yield* TestClock.adjust(Duration.millis(100));
      expect(fake.recordsFor(INSTALLED_TOOL_PATHS.openbox)).toHaveLength(1);

      yield* Fiber.interrupt(started);

      expect(fake.killOrder).toEqual([INSTALLED_TOOL_PATHS.openbox, INSTALLED_TOOL_PATHS.Xvfb]);
    }),
  );

  it.effect("drains the window manager's stderr instead of leaving it to fill", () =>
    Effect.gen(function* () {
      let pulled = 0;
      const chatty = Stream.fromIterable(
        Array.from({ length: 300 }, () => encoder.encode("openbox: X error\n")),
      ).pipe(Stream.tap(() => Effect.sync(() => (pulled += 1))));
      const fake = host({
        xdpyinfo: [READY],
        openbox: { runsUntilKilled: true, stderr: chatty },
      });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(400));
      yield* Fiber.join(started);
      yield* Effect.yieldNow;

      // Everything the child wrote was read, including well past the bound the
      // collector keeps.
      expect(pulled).toBe(300);
    }),
  );

  it.effect("needs the managed-session tools before it will start anything", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const failure = yield* startManagedXSession(
        {
          spawner: fake.spawner,
          tools: { ...NO_LINUX_TOOLS, xdpyinfo: "/usr/bin/xdpyinfo" },
          baseEnvironment: BASE_ENVIRONMENT,
        },
        {},
        new Set(),
      ).pipe(Effect.flip);

      expect(failure.code).toBe("setup_required");
      expect(fake.records).toHaveLength(0);
    }),
  );

  it.effect("stops apps, then the window manager, then the X server", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(400));
      const session = yield* Fiber.join(started);

      const pid = yield* session.launch("/usr/bin/xterm", ["-e", "bash"]);
      expect(fake.recordsFor("/usr/bin/xterm")[0]?.env.DISPLAY).toBe(":60");
      expect(pid).toBeGreaterThan(0);

      const stopping = yield* session.stop.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(stopping);

      // Killing the X server first makes every client above it die on an IO
      // error instead of exiting cleanly, so it goes last.
      expect(fake.killOrder).toEqual(["/usr/bin/xterm", "/usr/bin/openbox", "/usr/bin/Xvfb"]);
      expect(fake.recordsFor("/usr/bin/Xvfb")[0]?.kills).toEqual(["SIGTERM"]);
    }),
  );

  it.effect("is safe to stop twice", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(400));
      const session = yield* Fiber.join(started);

      const first = yield* session.stop.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(first);
      yield* session.stop;

      expect(fake.killOrder).toEqual(["/usr/bin/openbox", "/usr/bin/Xvfb"]);
    }),
  );
});
