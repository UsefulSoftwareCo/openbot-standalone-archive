import { describe, expect, it } from "@effect/vitest";
import { OpenbotComputerDisplayId, OpenbotComputerWindowId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

import { make } from "./LinuxX11ComputerBackend.ts";
import { LINUX_COMPUTER_TOOLS, type LinuxToolName } from "./LinuxTools.ts";
import {
  makeFakeFileSystem,
  makeFakeHost,
  XDPYINFO_OUTPUT,
  type FakeHost,
  type FakeProcess,
  type SpawnedCommand,
} from "./linuxHost.testkit.ts";

const displayId = OpenbotComputerDisplayId.make;

/** A structurally valid JPEG, so the backend reads real dimensions off it. */
function jpeg(width: number, height: number): Uint8Array {
  const header = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  return new Uint8Array([...header, 0xff, 0xd9]);
}

const SINGLE_MONITOR = "Monitors: 1\n 0: +*eDP-1 1600/344x1000/193+0+0  eDP-1";
const TWO_MONITORS = [
  "Monitors: 2",
  " 0: +*eDP-1 1920/344x1080/193+0+0  eDP-1",
  " 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1",
].join("\n");

const WINDOW_GEOMETRY = (x: number, y: number) =>
  `WINDOW=41943044\nX=${x}\nY=${y}\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n`;

interface HostOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly missingTools?: ReadonlyArray<LinuxToolName>;
  readonly packageManager?: string | null;
  readonly procNames?: Readonly<Record<string, string>>;
  readonly respond?: (command: SpawnedCommand, index: number) => FakeProcess | undefined;
}

const toolPath = (tool: LinuxToolName) => `/usr/bin/${tool}`;

/** Answers the probes a healthy single-monitor X11 host would. */
const defaultRespond = (command: SpawnedCommand): FakeProcess | undefined => {
  if (command.command === toolPath("xdpyinfo")) {
    return { stdout: XDPYINFO_OUTPUT(1600, 1000) };
  }
  if (command.command === toolPath("xrandr")) return { stdout: SINGLE_MONITOR };
  return {};
};

function fakeHost(options: HostOptions = {}) {
  const missing = new Set(options.missingTools ?? []);
  const present = new Set<string>(
    LINUX_COMPUTER_TOOLS.filter((tool) => !missing.has(tool)).map(toolPath),
  );
  const packageManager = options.packageManager === undefined ? "apt-get" : options.packageManager;
  if (packageManager !== null) present.add(`/usr/bin/${packageManager}`);
  const host = makeFakeHost(options.respond ?? defaultRespond);
  const fileSystem = makeFakeFileSystem({
    present,
    files: options.procNames ?? {},
  });
  return { host, fileSystem, present };
}

const backend = (options: HostOptions = {}) =>
  Effect.gen(function* () {
    const { host, fileSystem } = fakeHost(options);
    const shape = yield* make.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, host.spawner),
      Effect.provideService(
        HostProcessEnvironment,
        (options.environment ?? { PATH: "/usr/bin", DISPLAY: ":0" }) as NodeJS.ProcessEnv,
      ),
      Effect.provide(Path.layer),
    );
    return { shape, host } as const;
  });

/** Argv of every spawn of one executable, joined for readable assertions. */
const linesFor = (host: FakeHost, tool: LinuxToolName) =>
  host.recordsFor(toolPath(tool)).map((record) => record.args.join(" "));

describe("LinuxX11ComputerBackend", () => {
  it.effect("reports a Wayland-only host as unsupported with the reason", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        environment: { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" },
      });
      expect(shape.platform).toBe("unsupported");
      const described = yield* shape.describe;
      expect(described.session).toBe("unsupported");
      expect(described.capabilities.stream).toBe(false);
      expect(described.unavailableReason).toContain("Wayland");
    }),
  );

  it.effect("describes a provisioned shared desktop as ready, with no permission gates", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend();
      expect(shape.platform).toBe("linux");
      const described = yield* shape.describe;
      expect(described.session).toBe("shared-x11-desktop");
      expect(described.permissions).toEqual({
        screenCapture: "not-applicable",
        accessibility: "not-applicable",
        detail: null,
      });
      expect(described.capabilities).toEqual({
        stream: true,
        input: true,
        windows: true,
        focusWindow: true,
        managedDisplays: true,
        launchApp: true,
      });
      expect(described.setup?.ready).toBe(true);
      expect(described.unavailableReason).toBeNull();
    }),
  );

  it.effect("turns missing tools into an install plan and honest capabilities", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({ missingTools: ["ffmpeg", "Xvfb"] });
      const described = yield* shape.describe;
      expect(described.setup?.ready).toBe(false);
      expect(described.capabilities.stream).toBe(false);
      expect(described.capabilities.input).toBe(true);
      expect(described.capabilities.managedDisplays).toBe(false);
      expect(described.setup?.notes.join("\n")).toContain("sudo apt-get install -y");
      expect(described.unavailableReason).toContain("ffmpeg");
    }),
  );

  it.effect("calls a host with no desktop a managed X session host", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({ environment: { PATH: "/usr/bin" } });
      const described = yield* shape.describe;
      expect(described.session).toBe("managed-x11-session");
      expect(yield* shape.listDisplays).toEqual([]);
    }),
  );

  it.effect("offers a single-monitor screen as one display", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend();
      const displays = yield* shape.listDisplays;
      expect(displays).toEqual([
        {
          id: ":0",
          name: "eDP-1",
          kind: "physical",
          widthPx: 1600,
          heightPx: 1000,
          scale: 1,
          main: true,
          managed: false,
        },
      ]);
      expect(linesFor(host, "xdpyinfo")).toEqual([""]);
    }),
  );

  it.effect("offers one display per monitor when xrandr reports several", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        respond: (command) =>
          command.command === toolPath("xrandr")
            ? { stdout: TWO_MONITORS }
            : defaultRespond(command),
      });
      const displays = yield* shape.listDisplays;
      expect(displays.map((display) => display.id)).toEqual([":0/eDP-1", ":0/HDMI-1"]);
      expect(displays[0]).toMatchObject({ widthPx: 1920, heightPx: 1080, main: true });
      expect(displays[1]).toMatchObject({ widthPx: 2560, heightPx: 1440, main: false });
    }),
  );

  it.effect("falls back to the whole screen when xrandr is not installed", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({ missingTools: ["xrandr"] });
      const displays = yield* shape.listDisplays;
      expect(displays).toHaveLength(1);
      expect(displays[0]).toMatchObject({ id: ":0", widthPx: 1600, heightPx: 1000 });
    }),
  );

  it.effect("says the display did not answer instead of reporting an empty desktop", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        respond: (command) =>
          command.command === toolPath("xdpyinfo")
            ? { exitCode: 1, stderr: "unable to open display" }
            : defaultRespond(command),
      });
      const failure = yield* Effect.flip(shape.listDisplays);
      expect(failure.code).toBe("backend_unavailable");
      expect(failure.message).toContain(":0");
    }),
  );

  it.effect("captures a display and cuts the MJPEG stream into frames", () =>
    Effect.gen(function* () {
      const first = jpeg(800, 500);
      const second = jpeg(800, 500);
      const { shape, host } = yield* backend({
        environment: { PATH: "/usr/bin", DISPLAY: ":0", XAUTHORITY: "/run/xauth" },
        respond: (command) =>
          command.command === toolPath("ffmpeg")
            ? { stdout: [first, second] }
            : defaultRespond(command),
      });
      const frames = yield* shape.capture(displayId(":0"), {
        maxWidthPx: 800,
        fps: 12,
        quality: 0.8,
      });
      const collected = yield* Stream.runCollect(frames);

      expect(collected).toHaveLength(2);
      expect(collected[0]).toMatchObject({ displayId: ":0", widthPx: 800, heightPx: 500 });
      const argv = linesFor(host, "ffmpeg")[0] ?? "";
      expect(argv).toContain("-f x11grab");
      expect(argv).toContain("-framerate 12");
      expect(argv).toContain("-video_size 1600x1000");
      expect(argv).toContain("-i :0.0+0,0");
      expect(argv).toContain("-vf scale=800:-2");
      // A shared desktop has a real pointer the viewer needs to see.
      expect(argv).toContain("-draw_mouse 1");
      expect(host.recordsFor(toolPath("ffmpeg"))[0]?.env.XAUTHORITY).toBe("/run/xauth");
    }),
  );

  it.effect("fails the capture stream when ffmpeg dies on its own", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        respond: (command) =>
          command.command === toolPath("ffmpeg")
            ? { exitCode: 1, stderr: "Cannot open display :0" }
            : defaultRespond(command),
      });
      const frames = yield* shape.capture(displayId(":0"), {
        maxWidthPx: 800,
        fps: 12,
        quality: 0.8,
      });
      const failure = yield* Effect.flip(Stream.runCollect(frames));
      expect(failure.code).toBe("capture_failed");
      expect(failure.message).toContain("Cannot open display :0");
    }),
  );

  it.effect("captures one frame for a screenshot", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend({
        respond: (command) =>
          command.command === toolPath("ffmpeg")
            ? { stdout: [jpeg(640, 400)] }
            : defaultRespond(command),
      });
      const frame = yield* shape.screenshot(displayId(":0"), 640);
      expect(frame).toMatchObject({ displayId: ":0", widthPx: 640, heightPx: 400 });
      expect(linesFor(host, "ffmpeg")[0]).toContain("-frames:v 1");
    }),
  );

  it.effect("runs one xdotool per event, in order, with the display in the environment", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend({
        environment: { PATH: "/usr/bin", DISPLAY: ":0", XAUTHORITY: "/run/xauth" },
      });
      const result = yield* shape.input(displayId(":0"), [
        { type: "move", point: { x: 10, y: 20 } },
        { type: "click", button: "left", count: 1, point: { x: 10, y: 20 } },
        { type: "text", text: "hi" },
      ]);

      expect(result).toEqual({ delivered: 3, rejected: [] });
      expect(linesFor(host, "xdotool")).toEqual([
        "mousemove --sync 10 20",
        "mousemove --sync 10 20 click --repeat 1 --delay 60 1",
        "type --delay 12 -- hi",
      ]);
      const first = host.recordsFor(toolPath("xdotool"))[0];
      expect(first?.env.DISPLAY).toBe(":0");
      expect(first?.env.XAUTHORITY).toBe("/run/xauth");
    }),
  );

  it.effect("rejects the events it cannot map and delivers the rest", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend();
      const result = yield* shape.input(displayId(":0"), [
        { type: "key", key: "Fn", action: "down" },
        { type: "move", point: { x: 1, y: 1 } },
        { type: "scroll", point: { x: 1, y: 1 }, deltaX: 0, deltaY: 0 },
      ]);

      expect(result.delivered).toBe(1);
      expect(result.rejected).toEqual([
        { index: 0, reason: "unknown key Fn" },
        { index: 2, reason: "scroll had no delta" },
      ]);
      expect(linesFor(host, "xdotool")).toEqual(["mousemove --sync 1 1"]);
    }),
  );

  it.effect("reports an xdotool failure against the event that caused it", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        respond: (command) =>
          command.command === toolPath("xdotool")
            ? { exitCode: 1, stderr: "XTEST extension unavailable\n" }
            : defaultRespond(command),
      });
      const result = yield* shape.input(displayId(":0"), [{ type: "move", point: { x: 1, y: 1 } }]);
      expect(result).toEqual({
        delivered: 0,
        rejected: [{ index: 0, reason: "XTEST extension unavailable" }],
      });
    }),
  );

  it.effect("remembers what is held so release-all lets go of all of it", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend();
      yield* shape.input(displayId(":0"), [
        { type: "key", key: "ShiftLeft", action: "down" },
        { type: "button", button: "left", action: "down", point: { x: 4, y: 4 } },
      ]);
      const result = yield* shape.input(displayId(":0"), [{ type: "release-all" }]);

      expect(result).toEqual({ delivered: 1, rejected: [] });
      expect(linesFor(host, "xdotool")).toEqual([
        "keydown -- Shift_L",
        "mousemove --sync 4 4 mousedown 1",
        "keyup -- Shift_L",
        "mouseup 1",
      ]);
    }),
  );

  it.effect("offsets input onto the monitor the display names", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend({
        respond: (command) =>
          command.command === toolPath("xrandr")
            ? { stdout: TWO_MONITORS }
            : defaultRespond(command),
      });
      yield* shape.input(displayId(":0/HDMI-1"), [{ type: "move", point: { x: 5, y: 5 } }]);
      expect(linesFor(host, "xdotool")).toEqual(["mousemove --sync 1925 5"]);
    }),
  );

  it.effect("refuses input for a display that does not exist", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend();
      const failure = yield* Effect.flip(
        shape.input(displayId(":9"), [{ type: "move", point: { x: 0, y: 0 } }]),
      );
      expect(failure.code).toBe("display_not_found");
    }),
  );

  it.effect("lists visible windows with their app, frame, and focus", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        procNames: { "/proc/4242/comm": "firefox\n" },
        respond: (command) => {
          if (command.command !== toolPath("xdotool")) return defaultRespond(command);
          const [verb, argument] = command.args;
          if (verb === "search") return { stdout: "41943044\n" };
          if (verb === "getactivewindow") return { stdout: "41943044\n" };
          if (verb === "getwindowname") return { stdout: "T3 Code — Mozilla Firefox\n" };
          if (verb === "getwindowgeometry") return { stdout: WINDOW_GEOMETRY(100, 40) };
          if (verb === "getwindowpid") return { stdout: "4242\n" };
          return { exitCode: 1, stderr: `unexpected ${verb ?? ""} ${argument ?? ""}` };
        },
      });
      const windows = yield* shape.listWindows;
      expect(windows).toEqual([
        {
          id: ":0#41943044",
          displayId: ":0",
          title: "T3 Code — Mozilla Firefox",
          app: "firefox",
          pid: 4242,
          x: 100,
          y: 40,
          width: 800,
          height: 600,
          focused: true,
          minimized: false,
        },
      ]);
    }),
  );

  it.effect("focuses a window on the X display its id names", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend();
      yield* shape.focusWindow(OpenbotComputerWindowId.make(":0#41943044"));
      expect(linesFor(host, "xdotool")).toEqual(["windowactivate --sync 41943044"]);
    }),
  );

  it.effect("reports a window that cannot be focused as window_not_found", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        respond: (command) =>
          command.command === toolPath("xdotool")
            ? { exitCode: 1, stderr: "X Error of failed request" }
            : defaultRespond(command),
      });
      const failure = yield* Effect.flip(shape.focusWindow(OpenbotComputerWindowId.make(":0#1")));
      expect(failure.code).toBe("window_not_found");
    }),
  );

  it.effect("creates a managed X session, lists it, and destroys it", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend({
        environment: { PATH: "/usr/bin" },
        respond: (command) =>
          command.command === toolPath("xdpyinfo")
            ? { stdout: XDPYINFO_OUTPUT(1280, 720) }
            : { runsUntilKilled: true },
      });
      const changes = yield* Stream.runCollect(shape.changes.pipe(Stream.take(2))).pipe(
        Effect.forkScoped,
      );

      const creating = yield* shape
        .createDisplay({ widthPx: 1280, heightPx: 720, name: "Agent desktop" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(400));
      const created = yield* Fiber.join(creating);

      expect(created).toMatchObject({
        id: ":60",
        name: "Agent desktop",
        kind: "managed-x11",
        widthPx: 1280,
        heightPx: 720,
        managed: true,
        // The only desktop on a headless host has to be the default one.
        main: true,
      });
      expect(yield* shape.listDisplays).toHaveLength(1);
      expect(host.recordsFor("/usr/bin/Xvfb")[0]?.args[0]).toBe(":60");

      const destroying = yield* shape.destroyDisplay(displayId(":60")).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(destroying);

      expect(yield* shape.listDisplays).toEqual([]);
      expect(host.killOrder).toEqual(["/usr/bin/openbox", "/usr/bin/Xvfb"]);
      expect(yield* Fiber.join(changes)).toHaveLength(2);
    }),
  );

  it.effect("refuses to destroy a display it did not create", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend();
      const failure = yield* Effect.flip(shape.destroyDisplay(displayId(":0")));
      expect(failure.code).toBe("display_not_found");
    }),
  );

  it.effect("refuses to create a managed session without Xvfb and openbox", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        environment: { PATH: "/usr/bin" },
        missingTools: ["Xvfb", "openbox"],
      });
      const failure = yield* Effect.flip(shape.createDisplay({ widthPx: 800, heightPx: 600 }));
      expect(failure.code).toBe("setup_required");
    }),
  );

  it.effect("launches an app on the requested display", () =>
    Effect.gen(function* () {
      const { shape, host } = yield* backend();
      const result = yield* shape.launch({
        app: "/usr/bin/xterm",
        args: ["-e", "bash"],
        displayId: displayId(":0"),
      });
      expect(result.pid).toBeGreaterThan(0);
      const record = host.recordsFor("/usr/bin/xterm")[0];
      expect(record?.args).toEqual(["-e", "bash"]);
      expect(record?.env.DISPLAY).toBe(":0");
    }),
  );

  it.effect("reports a launch that could not start", () =>
    Effect.gen(function* () {
      const { shape } = yield* backend({
        respond: (command) =>
          command.command === "/usr/bin/nope" ? { spawnError: "ENOENT" } : defaultRespond(command),
      });
      const failure = yield* Effect.flip(shape.launch({ app: "/usr/bin/nope" }));
      expect(failure.code).toBe("invalid_input");
    }),
  );
});
