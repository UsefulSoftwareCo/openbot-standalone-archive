// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentPlatformOs,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  make,
  PERMISSION_CAVEAT,
  SCREENCAPTURE_PATH,
  parseDisplays,
} from "./OpenbotComputerService.ts";

const SYSTEM_PROFILER_JSON = JSON.stringify({
  SPDisplaysDataType: [
    {
      spdisplays_ndrvs: [
        {
          _name: "Studio Display",
          _spdisplays_pixels: "5120 x 2880",
          spdisplays_main: "spdisplays_yes",
        },
        { _name: "DELL U2720Q", _spdisplays_pixels: "3840 x 2160" },
      ],
    },
  ],
});

/**
 * A structurally valid JPEG: SOI, a SOF0 frame header carrying the dimensions,
 * then a comment segment padded to whatever size the test needs.
 */
function jpeg(width: number, height: number, totalBytes: number): Uint8Array {
  const sof0 = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];
  const dimensions = [height >> 8, height & 0xff, width >> 8, width & 0xff];
  const components = [0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const header = [...sof0, ...dimensions, ...components];
  const padding = Math.max(0, totalBytes - header.length - 6);
  const bytes = new Uint8Array(header.length + 4 + padding + 2);
  bytes.set(header, 0);
  // COM marker whose payload absorbs the padding.
  bytes[header.length] = 0xff;
  bytes[header.length + 1] = 0xfe;
  bytes[header.length + 2] = ((padding + 2) >> 8) & 0xff;
  bytes[header.length + 3] = (padding + 2) & 0xff;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

interface FakeHost {
  readonly systemProfilerJson?: string;
  readonly captureBytes?: Uint8Array;
  readonly captureExitCode?: number;
  readonly captureStderr?: string;
}

interface SpawnLog {
  readonly captures: Array<string>;
  readonly resamples: Array<string>;
}

function fakeSpawner(host: FakeHost, log: SpawnLog) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    const handle = (stdout: string, exitCode: number, stderr = "") =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.encodeText(Stream.make(stderr)),
        all: Stream.encodeText(Stream.make(stdout)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    if (executable.endsWith("system_profiler")) {
      return Effect.succeed(handle(host.systemProfilerJson ?? "", 0));
    }
    if (executable.endsWith("screencapture")) {
      const target = args[3] ?? "";
      const exitCode = host.captureExitCode ?? 0;
      return Effect.sync(() => {
        log.captures.push(target);
        if (exitCode === 0) NodeFS.writeFileSync(target, host.captureBytes ?? jpeg(100, 100, 64));
        return handle("", exitCode, host.captureStderr ?? "");
      });
    }
    if (executable.endsWith("sips")) {
      return Effect.sync(() => {
        log.resamples.push(args[1] ?? "");
        return handle("", 0);
      });
    }
    return Effect.die(`unexpected command ${executable}`);
  });
}

function descriptor(os: ExecutionEnvironmentPlatformOs): ExecutionEnvironmentDescriptor {
  return {
    environmentId: EnvironmentId.make("env-test"),
    label: "Test Mac Studio",
    platform: { os, arch: "arm64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  };
}

/**
 * Builds the service against a fake host. `screencapturePresent` overrides only
 * that one existence probe so the darwin paths are testable off a Mac.
 */
function service(options: {
  readonly os: ExecutionEnvironmentPlatformOs;
  readonly host?: FakeHost;
  readonly screencapturePresent?: boolean;
  readonly log?: SpawnLog;
}) {
  const log = options.log ?? { captures: [], resamples: [] };
  return Effect.gen(function* () {
    const realFs = yield* FileSystem.FileSystem;
    const present = options.screencapturePresent ?? true;
    return yield* make.pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...realFs,
          exists: (path) =>
            path === SCREENCAPTURE_PATH ? Effect.succeed(present) : realFs.exists(path),
        }),
      ),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        fakeSpawner(options.host ?? {}, log),
      ),
      Effect.provideService(
        ServerEnvironment,
        ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-test")),
          getDescriptor: Effect.succeed(descriptor(options.os)),
        }),
      ),
    );
  });
}

it.layer(NodeServices.layer)("OpenbotComputerService", (it) => {
  it.effect("reports non-macOS hosts as unsupported", () =>
    Effect.gen(function* () {
      const computer = yield* service({ os: "linux" });
      const status = yield* computer.status;
      expect(status.availability).toBe("unsupported");
      expect(status.detail).toBe("Screen preview is only implemented for macOS hosts.");
      expect(status.displays).toBeNull();
      expect(status.host).toEqual({ label: "Test Mac Studio", platform: "linux" });
      expect(status.session).toBe("signed-in-desktop");

      const failure = yield* computer.snapshot({}).pipe(Effect.flip);
      expect(failure.code).toBe("unsupported");
    }),
  );

  it.effect("reads the attached displays from system_profiler", () =>
    Effect.gen(function* () {
      const computer = yield* service({
        os: "darwin",
        host: { systemProfilerJson: SYSTEM_PROFILER_JSON },
      });
      const status = yield* computer.status;
      expect(status.availability).toBe("ready");
      expect(status.detail).toBeNull();
      expect(status.displays).toEqual([
        {
          id: "display-0",
          name: "Studio Display",
          widthPx: 5120,
          heightPx: 2880,
          main: true,
        },
        { id: "display-1", name: "DELL U2720Q", widthPx: 3840, heightPx: 2160, main: false },
      ]);
    }),
  );

  it.effect("stays ready when the display list cannot be parsed", () =>
    Effect.gen(function* () {
      const computer = yield* service({ os: "darwin", host: { systemProfilerJson: "not json" } });
      const status = yield* computer.status;
      expect(status.availability).toBe("ready");
      expect(status.displays).toBeNull();
      expect(status.detail).toContain("display list");
    }),
  );

  it.effect("reports unavailable when the host has no screencapture", () =>
    Effect.gen(function* () {
      const computer = yield* service({ os: "darwin", screencapturePresent: false });
      const status = yield* computer.status;
      expect(status.availability).toBe("unavailable");
      expect(status.detail).toContain(SCREENCAPTURE_PATH);
    }),
  );

  it.effect("captures the main display and reports its size", () =>
    Effect.gen(function* () {
      const log: SpawnLog = { captures: [], resamples: [] };
      const computer = yield* service({
        os: "darwin",
        host: { captureBytes: jpeg(1280, 800, 40_000) },
        log,
      });
      const snapshot = yield* computer.snapshot({ maxWidthPx: 1280 });
      expect(snapshot.mimeType).toBe("image/jpeg");
      expect(snapshot.widthPx).toBe(1280);
      expect(snapshot.heightPx).toBe(800);
      expect(snapshot.caveat).toBeNull();
      expect(snapshot.dataBase64.length).toBeGreaterThan(0);
      expect(log.captures).toHaveLength(1);
      expect(log.resamples).toEqual(["1280"]);
      // The capture is cleaned up with its scoped temp directory.
      expect(NodeFS.existsSync(log.captures[0] ?? "")).toBe(false);
    }),
  );

  it.effect("flags a suspiciously small capture as a permission problem", () =>
    Effect.gen(function* () {
      const computer = yield* service({
        os: "darwin",
        host: { captureBytes: jpeg(1280, 800, 2_000) },
      });
      const snapshot = yield* computer.snapshot({});
      expect(snapshot.caveat).toBe(PERMISSION_CAVEAT);
    }),
  );

  it.effect("fails with the exit detail when screencapture cannot run", () =>
    Effect.gen(function* () {
      const computer = yield* service({
        os: "darwin",
        host: { captureExitCode: 1, captureStderr: "could not create image" },
      });
      const failure = yield* computer.snapshot({}).pipe(Effect.flip);
      expect(failure.code).toBe("capture_failed");
      expect(failure.message).toContain("could not create image");
    }),
  );

  it.effect("reuses the last capture inside the one-second spacing window", () =>
    Effect.gen(function* () {
      const log: SpawnLog = { captures: [], resamples: [] };
      const computer = yield* service({
        os: "darwin",
        host: { captureBytes: jpeg(1280, 800, 40_000) },
        log,
      });
      const first = yield* computer.snapshot({});
      const immediate = yield* computer.snapshot({});
      expect(log.captures).toHaveLength(1);
      expect(immediate).toBe(first);

      yield* TestClock.adjust("1 second");
      yield* computer.snapshot({});
      expect(log.captures).toHaveLength(2);
    }),
  );
});

it("parses a display entry with an unreadable pixel string", () => {
  const displays = parseDisplays(
    JSON.stringify({
      SPDisplaysDataType: [{ spdisplays_ndrvs: [{ _name: "Sidecar", _spdisplays_pixels: "?" }] }],
    }),
  );
  expect(displays).toEqual([
    { id: "display-0", name: "Sidecar", widthPx: null, heightPx: null, main: false },
  ]);
});
