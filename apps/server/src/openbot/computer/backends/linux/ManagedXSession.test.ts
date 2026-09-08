import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import {
  INSTALLED_TOOL_PATHS,
  makeFakeFileSystem,
  makeFakeHost,
  XDPYINFO_OUTPUT,
  type FakeHost,
  type FakeProcess,
  type SpawnedCommand,
} from "./linuxHost.testkit.ts";
import {
  allocateDisplayNumber,
  MANAGED_DISPLAY_BASE,
  startManagedXSession,
  type ManagedXSessionSpec,
} from "./ManagedXSession.ts";
import { NO_LINUX_TOOLS } from "./LinuxTools.ts";

const BASE_ENVIRONMENT = { PATH: "/usr/bin", HOME: "/home/agent" };

/** Answers Xvfb and openbox as long-running children, and xdpyinfo from a
    script of successive replies so readiness can be delayed. */
function host(options: { readonly xdpyinfo: ReadonlyArray<FakeProcess> }): FakeHost {
  let probes = 0;
  return makeFakeHost((command: SpawnedCommand) => {
    if (command.command === INSTALLED_TOOL_PATHS.xdpyinfo) {
      const reply = options.xdpyinfo[Math.min(probes, options.xdpyinfo.length - 1)];
      probes += 1;
      return reply ?? { exitCode: 1 };
    }
    return { runsUntilKilled: true };
  });
}

const start = (
  fake: FakeHost,
  spec: ManagedXSessionSpec = {},
  options?: {
    readonly existingSockets?: ReadonlySet<string>;
    readonly taken?: ReadonlySet<number>;
  },
) =>
  startManagedXSession(
    {
      spawner: fake.spawner,
      fileSystem: makeFakeFileSystem({ present: options?.existingSockets ?? new Set() }),
      tools: INSTALLED_TOOL_PATHS,
      baseEnvironment: BASE_ENVIRONMENT,
    },
    spec,
    options?.taken ?? new Set(),
  );

const READY = { stdout: XDPYINFO_OUTPUT(1600, 1000), exitCode: 0 } satisfies FakeProcess;
const NOT_READY = { exitCode: 1 } satisfies FakeProcess;

describe("allocateDisplayNumber", () => {
  it.effect("takes the first number with no socket and no in-process owner", () =>
    Effect.gen(function* () {
      const fileSystem = makeFakeFileSystem({
        present: new Set(["/tmp/.X11-unix/X60", "/tmp/.X11-unix/X61"]),
      });
      expect(yield* allocateDisplayNumber(fileSystem, new Set())).toBe(62);
      expect(yield* allocateDisplayNumber(fileSystem, new Set([62, 63]))).toBe(64);
    }),
  );

  it.effect("starts at the managed base so it can never collide with :0", () =>
    Effect.gen(function* () {
      const free = yield* allocateDisplayNumber(makeFakeFileSystem({}), new Set());
      expect(free).toBe(MANAGED_DISPLAY_BASE);
    }),
  );

  it.effect("reports backend_unavailable when every number is taken", () =>
    Effect.gen(function* () {
      const taken = new Set(Array.from({ length: 65 }, (_, index) => 60 + index));
      const failure = yield* allocateDisplayNumber(makeFakeFileSystem({}), taken).pipe(Effect.flip);
      expect(failure.code).toBe("backend_unavailable");
    }),
  );
});

describe("startManagedXSession", () => {
  it.effect("starts Xvfb, waits for the display, then the window manager", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const started = yield* start(fake).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // The window manager settle is the only wait left once X answers.
      yield* TestClock.adjust(Duration.millis(400));
      const session = yield* Fiber.join(started);

      expect(session.display).toBe(":60");
      expect(session.widthPx).toBe(1600);
      expect(session.heightPx).toBe(1000);
      expect(fake.commandLines()).toEqual([
        "/usr/bin/Xvfb :60 -screen 0 1600x1000x24 +extension GLX +extension RANDR +extension RENDER -dpi 96 -noreset -nolisten tcp",
        "/usr/bin/xdpyinfo",
        "/usr/bin/openbox",
      ]);
      expect(fake.records[2]?.env.DISPLAY).toBe(":60");
    }),
  );

  it.effect("uses the requested size and skips display numbers already in use", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [{ stdout: XDPYINFO_OUTPUT(1280, 720), exitCode: 0 }] });
      const started = yield* start(
        fake,
        { widthPx: 1280, heightPx: 720, name: "Browser" },
        {
          existingSockets: new Set(["/tmp/.X11-unix/X60"]),
        },
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(400));
      const session = yield* Fiber.join(started);

      expect(session.display).toBe(":61");
      expect(session.name).toBe("Browser");
      expect(fake.commandLines()[0]).toContain(":61 -screen 0 1280x720x24");
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
      const fake = makeFakeHost((command) =>
        command.command === INSTALLED_TOOL_PATHS.xdpyinfo
          ? { exitCode: 1, stderr: "unable to open display" }
          : { runsUntilKilled: true, stderr: "Cannot establish any listening sockets" },
      );
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

  it.effect("needs the managed-session tools before it will start anything", () =>
    Effect.gen(function* () {
      const fake = host({ xdpyinfo: [READY] });
      const failure = yield* startManagedXSession(
        {
          spawner: fake.spawner,
          fileSystem: makeFakeFileSystem({}),
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
