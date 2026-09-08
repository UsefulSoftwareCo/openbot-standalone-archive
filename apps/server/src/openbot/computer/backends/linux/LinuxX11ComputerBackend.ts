import {
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  OpenbotComputerWindowId,
  type OpenbotComputerCapabilities,
  type OpenbotComputerDisplay,
  type OpenbotComputerDisplayCreateInput,
  type OpenbotComputerInputEvent,
  type OpenbotComputerInputRejection,
  type OpenbotComputerInputResult,
  type OpenbotComputerLaunchInput,
  type OpenbotComputerLaunchResult,
  type OpenbotComputerPermissions,
  type OpenbotComputerWindow,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../../../stream/collectUint8StreamText.ts";
import {
  ComputerBackend,
  type CaptureProfile,
  type ComputerBackendDescription,
  type ComputerBackendShape,
  type ComputerFrame,
} from "../../ComputerBackend.ts";
import { makeUnsupportedBackend } from "../unsupported.ts";
import { detectLinuxSession } from "./LinuxSessionDetect.ts";
import {
  discoverLinuxTools,
  detectPackageManager,
  linuxComputerSetup,
  type LinuxPackageManager,
  type LinuxToolPaths,
} from "./LinuxTools.ts";
import {
  EMPTY_JPEG_SPLIT_STATE,
  readJpegSize,
  splitJpegChunk,
  type JpegSplitState,
} from "./JpegSplitter.ts";
import { startManagedXSession, type ManagedXSession } from "./ManagedXSession.ts";
import {
  ffmpegArgs,
  ffmpegFrameSize,
  NO_X11_INPUT_HELD,
  parseDisplayName,
  parseWindowGeometryShell,
  parseXdpyinfoScreen,
  parseXrandrMonitors,
  xdotoolArgs,
  type X11InputHeld,
  type X11InputSurface,
} from "./X11Display.ts";

/**
 * The Linux backend: a shared X11 desktop reached through `DISPLAY`, plus any
 * headless X sessions this server started.
 *
 * Everything here is process mechanics over the pure builders and parsers in
 * this directory. The one piece of policy it owns is that input for a display
 * is serialized: every event is its own `xdotool` process, and two overlapping
 * runs race inside the X server (measured on a real host: "wsok" typed,
 * "wosk" received).
 */

/** X11 has no capture or input gate to ask about. */
const NOT_APPLICABLE: OpenbotComputerPermissions = {
  screenCapture: "not-applicable",
  accessibility: "not-applicable",
  detail: null,
};

/** `PATH` and the package manager do not change while a server runs, but a
    user installing the missing tools should not have to restart to see it. */
const TOOLS_CACHE_MS = 60_000;
/** Long enough that an input batch never pays for a display probe, short
    enough that a monitor hotplug shows up on the next status read. */
const TARGETS_CACHE_MS = 2_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Folds a one-frame capture's whole output, keeping the last complete image:
    ffmpeg can leave a partial frame behind when it stops. */
interface ScreenshotAccumulator {
  readonly state: JpegSplitState;
  readonly last: Uint8Array | null;
}

const accumulateScreenshot = (
  accumulator: ScreenshotAccumulator,
  chunk: Uint8Array,
): ScreenshotAccumulator => {
  const result = splitJpegChunk(accumulator.state, chunk);
  return { state: result.state, last: result.frames.at(-1) ?? accumulator.last };
};

/** One X display this backend can capture and drive: either a region of the
    shared desktop's screen, or a managed session's whole screen. */
interface X11Target {
  readonly display: OpenbotComputerDisplay;
  /** `DISPLAY` value for every tool addressing this display. */
  readonly displayName: string;
  readonly screen: number;
  /** Top-left of this display inside the screen's root window. */
  readonly originX: number;
  readonly originY: number;
  readonly managedSession: ManagedXSession | null;
}

interface CachedTargets {
  readonly atMs: number;
  readonly targets: ReadonlyArray<X11Target>;
}

interface CachedTools {
  readonly atMs: number;
  readonly tools: LinuxToolPaths;
  readonly packageManager: LinuxPackageManager | null;
}

const surfaceOf = (target: X11Target): X11InputSurface => ({
  originX: target.originX,
  originY: target.originY,
  widthPx: target.display.widthPx,
  heightPx: target.display.heightPx,
});

const displayNotFound = (id: string) =>
  new OpenbotComputerError({
    code: "display_not_found",
    message: `No display ${id} on this host.`,
  });

const setupRequired = (tool: string) =>
  new OpenbotComputerError({
    code: "setup_required",
    message: `This host has no ${tool} on PATH, so that is not possible yet.`,
  });

/** Builds the backend against whatever this Linux host actually is. The
    returned shape is the unsupported one on a Wayland-only session, which is
    the honest answer rather than a backend that fails every call. */
export const make: Effect.Effect<
  ComputerBackendShape,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  const session = detectLinuxSession(environment);
  if (session.kind === "wayland-only") return makeUnsupportedBackend(session.reason);

  const backendScope = yield* Effect.scope;
  const toolsRef = yield* Ref.make<CachedTools | null>(null);
  const targetsRef = yield* Ref.make<CachedTargets | null>(null);
  const sessionsRef = yield* Ref.make<ReadonlyArray<ManagedXSession>>([]);
  const heldRef = yield* Ref.make<ReadonlyMap<string, X11InputHeld>>(new Map());
  const inputLocksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
  // Sliding: a status refresh that nobody is listening for is worth dropping,
  // and this must never become a queue that grows for the life of the server.
  const changesPubSub = yield* PubSub.sliding<void>(4);

  const publishChange = PubSub.publish(changesPubSub, undefined).pipe(Effect.ignore);

  // -------------------------------------------------------------- processes

  const baseEnvironment = (): Record<string, string | undefined> => {
    const copy = { ...environment };
    delete copy.DISPLAY;
    return copy;
  };

  /** Env for a tool addressing one X display. A shared desktop's server
      usually needs its cookie file, and inheriting `XAUTHORITY` is the only
      way to get it; a managed session has no cookie at all. */
  const xEnvironment = (
    displayName: string,
    managed: boolean,
  ): Record<string, string | undefined> => {
    const env = baseEnvironment();
    env.DISPLAY = displayName;
    if (!managed && session.kind === "shared-x11" && session.xauthority !== null) {
      env.XAUTHORITY = session.xauthority;
    }
    return env;
  };

  const displayEnvironment = (target: X11Target): Record<string, string | undefined> =>
    xEnvironment(target.displayName, target.managedSession !== null);

  /**
   * Runs one command to completion. A missing binary or a non-zero exit is
   * information the caller turns into a typed error, so neither fails this
   * effect; defects and interruption still propagate.
   */
  const runCommand = (
    executable: string,
    args: ReadonlyArray<string>,
    env: Record<string, string | undefined>,
  ): Effect.Effect<CommandResult> =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, [...args], {
          env,
          shell: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout }),
          collectUint8StreamText({ stream: child.stderr }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: Number(exitCode),
      } satisfies CommandResult;
    }).pipe(
      Effect.scoped,
      Effect.catch((cause) =>
        Effect.succeed({
          stdout: "",
          stderr: `${executable} could not be run: ${cause.message}`,
          exitCode: -1,
        } satisfies CommandResult),
      ),
    );

  // ------------------------------------------------------------------ setup

  const readTools = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(toolsRef);
    if (cached !== null && nowMs - cached.atMs < TOOLS_CACHE_MS) return cached;
    const [tools, packageManager] = yield* Effect.all(
      [discoverLinuxTools({ fileSystem, path, environment }), detectPackageManager(fileSystem)],
      { concurrency: "unbounded" },
    );
    const fresh = { atMs: nowMs, tools, packageManager } satisfies CachedTools;
    yield* Ref.set(toolsRef, fresh);
    return fresh;
  });

  const capabilitiesFor = (tools: LinuxToolPaths): OpenbotComputerCapabilities => ({
    stream: tools.ffmpeg !== null,
    input: tools.xdotool !== null,
    windows: tools.xdotool !== null,
    focusWindow: tools.xdotool !== null,
    managedDisplays: tools.Xvfb !== null && tools.openbox !== null && tools.xdpyinfo !== null,
    launchApp: true,
  });

  const describe: Effect.Effect<ComputerBackendDescription, OpenbotComputerError> = Effect.gen(
    function* () {
      const { tools, packageManager } = yield* readTools;
      const shared = session.kind === "shared-x11";
      const setup = linuxComputerSetup({
        tools,
        packageManager,
        target: shared ? "shared-desktop" : "managed-session",
        extraNotes: shared ? session.notes : [],
      });
      return {
        session: shared ? "shared-x11-desktop" : "managed-x11-session",
        permissions: NOT_APPLICABLE,
        setup,
        capabilities: capabilitiesFor(tools),
        unavailableReason: setup.ready ? null : (setup.notes[0] ?? null),
      } satisfies ComputerBackendDescription;
    },
  );

  // --------------------------------------------------------------- displays

  const probeScreen = (displayName: string, xdpyinfo: string) =>
    runCommand(xdpyinfo, [], xEnvironment(displayName, false)).pipe(
      Effect.map((result) => (result.exitCode === 0 ? parseXdpyinfoScreen(result.stdout) : null)),
    );

  const sharedTargets = (tools: LinuxToolPaths) =>
    Effect.gen(function* () {
      if (session.kind !== "shared-x11" || tools.xdpyinfo === null) return [];
      const parsed = parseDisplayName(session.display);
      if (parsed === null) return [];
      const screen = yield* probeScreen(session.display, tools.xdpyinfo);
      if (screen === null) return [];

      const monitors =
        tools.xrandr === null
          ? []
          : yield* runCommand(
              tools.xrandr,
              ["--listmonitors"],
              xEnvironment(session.display, false),
            ).pipe(
              Effect.map((result) =>
                result.exitCode === 0 ? parseXrandrMonitors(result.stdout) : [],
              ),
            );

      // One monitor (or no xrandr) is one display covering the whole screen.
      // Splitting a single-monitor screen would only give the id an unstable
      // connector name for no gain.
      if (monitors.length < 2) {
        const id = parsed.screen === 0 ? parsed.base : `${parsed.base}.${parsed.screen}`;
        return [
          {
            display: {
              id: OpenbotComputerDisplayId.make(id),
              name: monitors[0]?.name ?? `Shared desktop ${parsed.base}`,
              kind: "physical",
              widthPx: screen.widthPx,
              heightPx: screen.heightPx,
              scale: 1,
              main: true,
              managed: false,
            },
            displayName: parsed.base,
            screen: parsed.screen,
            originX: 0,
            originY: 0,
            managedSession: null,
          } satisfies X11Target,
        ];
      }

      return monitors.map(
        (monitor, index) =>
          ({
            display: {
              id: OpenbotComputerDisplayId.make(`${parsed.base}/${monitor.name}`),
              name: monitor.name,
              kind: "physical",
              widthPx: monitor.widthPx,
              heightPx: monitor.heightPx,
              scale: 1,
              main: monitor.primary || (index === 0 && !monitors.some((each) => each.primary)),
              managed: false,
            },
            displayName: parsed.base,
            screen: parsed.screen,
            originX: monitor.x,
            originY: monitor.y,
            managedSession: null,
          }) satisfies X11Target,
      );
    });

  const managedTargets = (hasSharedDesktop: boolean) =>
    Effect.gen(function* () {
      const sessions = yield* Ref.get(sessionsRef);
      return sessions.map(
        (managed, index) =>
          ({
            display: {
              id: OpenbotComputerDisplayId.make(managed.display),
              name: managed.name,
              kind: "managed-x11",
              widthPx: managed.widthPx,
              heightPx: managed.heightPx,
              scale: 1,
              // A headless host's first managed session is the only desktop
              // there is, so it has to be the one a caller gets by default.
              main: !hasSharedDesktop && index === 0,
              managed: true,
            },
            displayName: managed.display,
            screen: 0,
            originX: 0,
            originY: 0,
            managedSession: managed,
          }) satisfies X11Target,
      );
    });

  const computeTargets = Effect.gen(function* () {
    const { tools } = yield* readTools;
    const shared = yield* sharedTargets(tools);
    const managed = yield* managedTargets(shared.length > 0);
    return [...shared, ...managed];
  });

  const invalidateTargets = Ref.set(targetsRef, null);

  const readTargets = (options?: { readonly fresh?: boolean }) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(targetsRef);
      if (options?.fresh !== true && cached !== null && nowMs - cached.atMs < TARGETS_CACHE_MS) {
        return cached.targets;
      }
      const targets = yield* computeTargets;
      yield* Ref.set(targetsRef, { atMs: nowMs, targets });
      return targets;
    });

  const listDisplays = Effect.gen(function* () {
    const targets = yield* readTargets();
    if (targets.length === 0 && session.kind === "shared-x11") {
      return yield* new OpenbotComputerError({
        code: "backend_unavailable",
        message: `The X display ${session.display} did not answer. Check that DISPLAY and XAUTHORITY name a session this server can reach.`,
      });
    }
    return targets.map((target) => target.display);
  });

  /** Resolves an id, re-reading the display list once before giving up so a
      display created moments ago is never reported missing. */
  const resolveTarget = (displayId: string) =>
    Effect.gen(function* () {
      const cached = yield* readTargets();
      const hit = cached.find((target) => target.display.id === displayId);
      if (hit !== undefined) return hit;
      const fresh = yield* readTargets({ fresh: true });
      const found = fresh.find((target) => target.display.id === displayId);
      if (found === undefined) return yield* displayNotFound(displayId);
      return found;
    });

  const resolveMainTarget = Effect.gen(function* () {
    const targets = yield* readTargets();
    const main = targets.find((target) => target.display.main) ?? targets[0];
    if (main === undefined) return yield* displayNotFound("(main)");
    return main;
  });

  // ---------------------------------------------------------------- capture

  const captureSpec = (target: X11Target, profile: CaptureProfile, frames: number | null) => ({
    display: target.displayName,
    screen: target.screen,
    x: target.originX,
    y: target.originY,
    widthPx: target.display.widthPx,
    heightPx: target.display.heightPx,
    fps: profile.fps,
    maxWidthPx: profile.maxWidthPx,
    quality: profile.quality,
    // Xvfb has no hardware cursor for x11grab to fetch, so asking for one only
    // logs a pointer-query error per frame; a shared desktop has a real one
    // the viewer needs to see.
    drawMouse: target.managedSession === null,
    frames,
  });

  const toFrame = (
    target: X11Target,
    fallbackWidthPx: number,
    fallbackHeightPx: number,
    jpeg: Uint8Array,
    capturedAtMs: number,
  ): ComputerFrame => {
    const size = readJpegSize(jpeg);
    return {
      displayId: target.display.id,
      jpeg,
      widthPx: size?.width ?? fallbackWidthPx,
      heightPx: size?.height ?? fallbackHeightPx,
      capturedAtMs,
    };
  };

  const capture = (displayId: OpenbotComputerDisplayId, profile: CaptureProfile) =>
    Effect.gen(function* () {
      const { tools } = yield* readTools;
      if (tools.ffmpeg === null) return yield* setupRequired("ffmpeg");
      const target = yield* resolveTarget(displayId);
      const spec = captureSpec(target, profile, null);
      const size = ffmpegFrameSize(spec);
      const stoppingRef = yield* Ref.make(false);
      const stderrRef = yield* Ref.make("");

      const child = yield* spawner
        .spawn(
          ChildProcess.make(tools.ffmpeg, [...ffmpegArgs(spec)], {
            env: displayEnvironment(target),
            shell: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: "3 seconds",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OpenbotComputerError({
                code: "capture_failed",
                message: `ffmpeg could not be started for ${displayId}: ${String(cause)}`,
              }),
          ),
        );

      // Registered after the spawn so it runs before the child is killed: a
      // capture the caller stopped must not be reported as a failure.
      yield* Effect.addFinalizer(() => Ref.set(stoppingRef, true));
      const stderrFiber = yield* Effect.forkScoped(
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Ref.update(stderrRef, (current) => (current + text).slice(0, 2_048)),
          ),
          Effect.ignore,
        ),
      );

      const frames = child.stdout.pipe(
        Stream.mapAccumArray(
          (): JpegSplitState => EMPTY_JPEG_SPLIT_STATE,
          (state, chunks) => {
            let next = state;
            const jpegs: Array<Uint8Array> = [];
            for (const chunk of chunks) {
              const result = splitJpegChunk(next, chunk);
              next = result.state;
              jpegs.push(...result.frames);
            }
            return [next, jpegs];
          },
        ),
        Stream.mapEffect((jpeg) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((nowMs) =>
              toFrame(target, size.frameWidthPx, size.frameHeightPx, jpeg, nowMs),
            ),
          ),
        ),
        Stream.mapError(
          (cause) =>
            new OpenbotComputerError({
              code: "capture_failed",
              message: `The capture of ${displayId} failed: ${String(cause)}`,
            }),
        ),
      );

      const reportExit = Effect.gen(function* () {
        const stopping = yield* Ref.get(stoppingRef);
        if (stopping) return;
        const exitCode = yield* child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        );
        if (exitCode === 0) return;
        // ffmpeg's own explanation is the useful half of this message, and it
        // is still in flight when stdout closes, so the collector is awaited
        // rather than sampled.
        yield* Fiber.await(stderrFiber).pipe(Effect.ignore);
        const stderr = (yield* Ref.get(stderrRef)).trim();
        return yield* new OpenbotComputerError({
          code: "capture_failed",
          message: `ffmpeg stopped capturing ${displayId} (exit ${exitCode})${
            stderr.length > 0 ? `: ${stderr.split("\n")[0] ?? ""}` : "."
          }`,
        });
      });

      return frames.pipe(Stream.concat(Stream.fromEffect(reportExit).pipe(Stream.drain)));
    });

  const screenshot = (displayId: OpenbotComputerDisplayId, maxWidthPx: number) =>
    Effect.gen(function* () {
      const { tools } = yield* readTools;
      if (tools.ffmpeg === null) return yield* setupRequired("ffmpeg");
      const target = yield* resolveTarget(displayId);
      const spec = captureSpec(target, { maxWidthPx, fps: 1, quality: 0.8 }, 1);
      const size = ffmpegFrameSize(spec);
      const child = yield* spawner
        .spawn(
          ChildProcess.make(tools.ffmpeg, [...ffmpegArgs(spec)], {
            env: displayEnvironment(target),
            shell: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: "3 seconds",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OpenbotComputerError({
                code: "capture_failed",
                message: `ffmpeg could not be started for ${displayId}: ${String(cause)}`,
              }),
          ),
        );
      const [stdout, stderr] = yield* Effect.all(
        [
          Stream.runFold(
            child.stdout,
            (): ScreenshotAccumulator => ({ state: EMPTY_JPEG_SPLIT_STATE, last: null }),
            accumulateScreenshot,
          ),
          collectUint8StreamText({ stream: child.stderr }),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.timeout(SCREENSHOT_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new OpenbotComputerError({
              code: "capture_failed",
              message: `Capturing ${displayId} failed: ${String(cause)}`,
            }),
        ),
      );
      const jpeg = stdout.last;
      if (jpeg === null) {
        const detail = stderr.text.trim();
        return yield* new OpenbotComputerError({
          code: "capture_failed",
          message: `ffmpeg produced no image for ${displayId}${
            detail.length > 0 ? `: ${detail.split("\n")[0] ?? ""}` : "."
          }`,
        });
      }
      const capturedAtMs = yield* Clock.currentTimeMillis;
      return toFrame(target, size.frameWidthPx, size.frameHeightPx, jpeg, capturedAtMs);
    }).pipe(Effect.scoped);

  // ------------------------------------------------------------------ input

  const lockFor = (displayId: string) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(inputLocksRef)).get(displayId);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(inputLocksRef, (locks) => {
        const found = locks.get(displayId);
        if (found !== undefined) return [found, locks];
        const next = new Map(locks);
        next.set(displayId, created);
        return [created, next];
      });
    });

  const input = (
    displayId: OpenbotComputerDisplayId,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) =>
    Effect.gen(function* () {
      const { tools } = yield* readTools;
      const xdotool = tools.xdotool;
      if (xdotool === null) return yield* setupRequired("xdotool");
      const target = yield* resolveTarget(displayId);
      const lock = yield* lockFor(displayId);
      const env = displayEnvironment(target);
      const surface = surfaceOf(target);

      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          let held = (yield* Ref.get(heldRef)).get(displayId) ?? NO_X11_INPUT_HELD;
          const rejected: Array<OpenbotComputerInputRejection> = [];
          let delivered = 0;

          for (const [index, event] of events.entries()) {
            const plan = xdotoolArgs(event, { surface, held });
            if (plan._tag === "rejected") {
              rejected.push({ index, reason: plan.reason });
              continue;
            }
            let failure: string | null = null;
            for (const args of plan.commands) {
              const result = yield* runCommand(xdotool, args, env);
              if (result.exitCode === 0) continue;
              const detail = result.stderr.trim().split("\n")[0] ?? "";
              failure = detail.length > 0 ? detail : `xdotool exited ${result.exitCode}`;
              break;
            }
            if (failure !== null) {
              rejected.push({ index, reason: failure });
              continue;
            }
            held = plan.held;
            delivered += 1;
          }

          yield* Ref.update(heldRef, (current) => {
            const next = new Map(current);
            next.set(displayId, held);
            return next;
          });
          return { delivered, rejected } satisfies OpenbotComputerInputResult;
        }),
      );
    });

  // ---------------------------------------------------------------- windows

  /** The owning program's name, from `/proc`. Empty when the process is gone
      or the kernel does not expose it, which the UI renders as no app name
      rather than a guess. */
  const processName = (pid: number) =>
    fileSystem.readFileString(`/proc/${pid}/comm`).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );

  const windowsOfTarget = (
    xdotool: string,
    xDisplay: { readonly displayName: string; readonly env: Record<string, string | undefined> },
    displaysOnServer: ReadonlyArray<X11Target>,
  ) =>
    Effect.gen(function* () {
      const found = yield* runCommand(
        xdotool,
        ["search", "--onlyvisible", "--name", ".+"],
        xDisplay.env,
      );
      if (found.exitCode !== 0) return [];
      const active = yield* runCommand(xdotool, ["getactivewindow"], xDisplay.env);
      const activeId = active.exitCode === 0 ? active.stdout.trim() : "";
      const ids = found.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const windows: Array<OpenbotComputerWindow> = [];
      for (const xid of ids) {
        const [title, geometry, owningPid] = yield* Effect.all(
          [
            runCommand(xdotool, ["getwindowname", xid], xDisplay.env),
            runCommand(xdotool, ["getwindowgeometry", "--shell", xid], xDisplay.env),
            runCommand(xdotool, ["getwindowpid", xid], xDisplay.env),
          ],
          { concurrency: "unbounded" },
        );
        if (title.exitCode !== 0) continue;
        const frame = parseWindowGeometryShell(geometry.stdout);
        if (frame === null) continue;
        const parsedPid = Number.parseInt(owningPid.stdout.trim(), 10);
        const pid = owningPid.exitCode === 0 && Number.isFinite(parsedPid) ? parsedPid : null;
        const app = pid === null ? "" : yield* processName(pid);
        // The X window id alone is not unique across two X servers this
        // process owns, so the display it lives on is part of the handle.
        const id = OpenbotComputerWindowId.make(`${xDisplay.displayName}#${xid}`);
        const owner =
          displaysOnServer.find(
            (target) =>
              frame.x >= target.originX &&
              frame.x < target.originX + target.display.widthPx &&
              frame.y >= target.originY &&
              frame.y < target.originY + target.display.heightPx,
          ) ?? displaysOnServer[0];
        windows.push({
          id,
          displayId: owner?.display.id ?? null,
          title: title.stdout.trim(),
          app,
          pid,
          x: frame.x - (owner?.originX ?? 0),
          y: frame.y - (owner?.originY ?? 0),
          width: frame.widthPx,
          height: frame.heightPx,
          focused: xid === activeId,
          minimized: false,
        });
      }
      return windows;
    });

  const listWindows = Effect.gen(function* () {
    const { tools } = yield* readTools;
    if (tools.xdotool === null) return [];
    const targets = yield* readTargets();
    const byDisplayName = new Map<string, Array<X11Target>>();
    for (const target of targets) {
      const group = byDisplayName.get(target.displayName);
      if (group === undefined) byDisplayName.set(target.displayName, [target]);
      else group.push(target);
    }
    const windows: Array<OpenbotComputerWindow> = [];
    for (const [displayName, group] of byDisplayName) {
      const first = group[0];
      if (first === undefined) continue;
      windows.push(
        ...(yield* windowsOfTarget(
          tools.xdotool,
          { displayName, env: displayEnvironment(first) },
          group,
        )),
      );
    }
    return windows;
  });

  const focusWindow = (windowId: OpenbotComputerWindowId) =>
    Effect.gen(function* () {
      const { tools } = yield* readTools;
      if (tools.xdotool === null) return yield* setupRequired("xdotool");
      const separator = windowId.lastIndexOf("#");
      const displayName = separator < 0 ? null : windowId.slice(0, separator);
      const xid = separator < 0 ? windowId : windowId.slice(separator + 1);
      const targets = yield* readTargets();
      const target = targets.find(
        (each) => displayName === null || each.displayName === displayName,
      );
      if (target === undefined) {
        return yield* new OpenbotComputerError({
          code: "window_not_found",
          message: `No window ${windowId} on this host.`,
        });
      }
      const result = yield* runCommand(
        tools.xdotool,
        ["windowactivate", "--sync", xid],
        displayEnvironment(target),
      );
      if (result.exitCode !== 0) {
        return yield* new OpenbotComputerError({
          code: "window_not_found",
          message: `Window ${windowId} could not be focused: ${
            result.stderr.trim().split("\n")[0] || `xdotool exited ${result.exitCode}`
          }`,
        });
      }
    });

  // -------------------------------------------------------- managed display

  const createDisplay = (request: OpenbotComputerDisplayCreateInput) =>
    Effect.gen(function* () {
      const { tools } = yield* readTools;
      const existing = yield* Ref.get(sessionsRef);
      const managed = yield* startManagedXSession(
        { spawner, fileSystem, tools, baseEnvironment: baseEnvironment() },
        {
          widthPx: request.widthPx,
          heightPx: request.heightPx,
          ...(request.name === undefined ? {} : { name: request.name }),
        },
        new Set(existing.map((each) => each.displayNumber)),
      );
      yield* Ref.update(sessionsRef, (sessions) => [...sessions, managed]);
      yield* invalidateTargets;
      yield* publishChange;
      const targets = yield* readTargets({ fresh: true });
      const created = targets.find((target) => target.display.id === managed.display);
      if (created === undefined) return yield* displayNotFound(managed.display);
      return created.display;
    });

  const destroyDisplay = (displayId: OpenbotComputerDisplayId) =>
    Effect.gen(function* () {
      const sessions = yield* Ref.get(sessionsRef);
      const managed = sessions.find((each) => each.display === displayId);
      if (managed === undefined) return yield* displayNotFound(displayId);
      yield* Ref.update(sessionsRef, (current) => current.filter((each) => each !== managed));
      yield* managed.stop;
      yield* Ref.update(heldRef, (current) => {
        const next = new Map(current);
        next.delete(displayId);
        return next;
      });
      yield* invalidateTargets;
      yield* publishChange;
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* Ref.getAndSet(sessionsRef, []);
      for (const managed of sessions) yield* managed.stop;
    }),
  );

  // ----------------------------------------------------------------- launch

  const launch = (
    request: OpenbotComputerLaunchInput,
  ): Effect.Effect<OpenbotComputerLaunchResult, OpenbotComputerError> =>
    Effect.gen(function* () {
      const target =
        request.displayId === undefined
          ? yield* resolveMainTarget
          : yield* resolveTarget(request.displayId);
      const args = [...(request.args ?? [])];
      if (target.managedSession !== null) {
        const pid = yield* target.managedSession.launch(request.app, args);
        return { pid };
      }
      // On the shared desktop the app outlives this call and this server; it
      // is the user's own session, so it is spawned detached and unrefed
      // rather than tied to a request scope that closes underneath it.
      const child = yield* spawner
        .spawn(
          ChildProcess.make(request.app, args, {
            env: displayEnvironment(target),
            shell: false,
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, backendScope),
          Effect.mapError(
            (cause) =>
              new OpenbotComputerError({
                code: "invalid_input",
                message: `${request.app} could not be started: ${String(cause)}`,
              }),
          ),
        );
      yield* child.unref.pipe(Effect.ignore);
      return { pid: Number(child.pid) };
    });

  const shape: ComputerBackendShape = {
    platform: "linux",
    describe,
    listDisplays,
    listWindows,
    focusWindow,
    screenshot,
    capture,
    input,
    createDisplay,
    destroyDisplay,
    launch,
    changes: Stream.fromPubSub(changesPubSub),
  };
  return shape;
});

export const layer: Layer.Layer<
  ComputerBackend,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(ComputerBackend, Effect.map(make, ComputerBackend.of));
