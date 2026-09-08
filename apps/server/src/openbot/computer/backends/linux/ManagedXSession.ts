import { OpenbotComputerError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../../../stream/collectUint8StreamText.ts";
import type { LinuxToolPaths } from "./LinuxTools.ts";
import {
  DEFAULT_MANAGED_HEIGHT_PX,
  DEFAULT_MANAGED_WIDTH_PX,
  parseXdpyinfoScreen,
  xvfbArgs,
} from "./X11Display.ts";

/**
 * A headless desktop this server started and owns: one `Xvfb`, one `openbox`,
 * and whatever apps were launched onto it.
 *
 * The session exists so a host with no desktop still has somewhere for an
 * agent to open a browser. It is not an isolated desktop per agent — it is one
 * more desktop, with the same single pointer and single focused window as any
 * other.
 */

/** Display numbers below this are where real sessions live; a managed one must
    never collide with the user's own `:0`. */
export const MANAGED_DISPLAY_BASE = 60;
export const MANAGED_DISPLAY_LIMIT = 125;

/** How long the X server gets to answer before the session is abandoned. */
export const READY_TIMEOUT = Duration.seconds(15);
const READY_POLL_INTERVAL = Duration.millis(200);
/** A window manager that has not finished mapping its root window drops the
    first app's window on the floor, so startup waits this out rather than
    letting the first launch race it. */
const WINDOW_MANAGER_SETTLE = Duration.millis(400);
/** Long enough for an X server to flush and exit cleanly, short enough that a
    wedged one does not hold up shutdown. */
export const FORCE_KILL_AFTER = Duration.seconds(3);

/** Applied to every child so an interrupted scope tears down the same way an
    explicit `stop` does. */
const KILL_OPTIONS = {
  killSignal: "SIGTERM",
  forceKillAfter: FORCE_KILL_AFTER,
} as const;

/** Enough stderr to explain a failure, little enough that a chatty tool cannot
    grow the heap for the life of the session. */
const MAX_STDERR_BYTES = 4_096;

export interface ManagedXSessionSpec {
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
  readonly name?: string | undefined;
}

export interface ManagedXSession {
  readonly displayNumber: number;
  /** `":60"`, ready to be both a `DISPLAY` value and a display id. */
  readonly display: string;
  readonly name: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly createdAtMs: number;
  /**
   * Starts an app on this session's display. The child belongs to the session,
   * so it is stopped before the window manager and the X server are.
   */
  readonly launch: (
    executable: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<number, OpenbotComputerError>;
  /** Stops apps, then openbox, then the X server. Safe to run twice. */
  readonly stop: Effect.Effect<void>;
}

export interface ManagedXSessionDependencies {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly tools: LinuxToolPaths;
  /** What the tools inherit. `DISPLAY` is always replaced with this session's. */
  readonly baseEnvironment: Readonly<Record<string, string | undefined>>;
}

const setupRequired = (message: string) =>
  new OpenbotComputerError({ code: "setup_required", message });
const backendUnavailable = (message: string) =>
  new OpenbotComputerError({ code: "backend_unavailable", message });

/**
 * The next free X display number.
 *
 * The socket in `/tmp/.X11-unix` is the only authority: a lock file can
 * survive a killed server, and picking a number a live server owns makes Xvfb
 * exit with a message nobody reads. `taken` covers the sessions this process
 * started, whose sockets may not exist yet.
 */
export const allocateDisplayNumber = (
  fileSystem: FileSystem.FileSystem,
  taken: ReadonlySet<number>,
): Effect.Effect<number, OpenbotComputerError> =>
  Effect.gen(function* () {
    for (let candidate = MANAGED_DISPLAY_BASE; candidate < MANAGED_DISPLAY_LIMIT; candidate += 1) {
      if (taken.has(candidate)) continue;
      const occupied = yield* fileSystem
        .exists(`/tmp/.X11-unix/X${candidate}`)
        .pipe(Effect.orElseSucceed(() => false));
      if (!occupied) return candidate;
    }
    return yield* backendUnavailable(
      `No free X display number between :${MANAGED_DISPLAY_BASE} and :${MANAGED_DISPLAY_LIMIT - 1}.`,
    );
  });

/** SIGTERM, then insist. A leaked Xvfb owns a display number the next session
    wants, and a leaked openbox keeps a dead display's windows alive. */
const stopChild = (child: ChildProcessSpawner.ChildProcessHandle) =>
  child.kill(KILL_OPTIONS).pipe(Effect.ignore, Effect.andThen(Effect.ignore(child.exitCode)));

/**
 * Starts a managed session and waits until it can actually be used.
 *
 * Fails with `setup_required` when the host lacks the programs, and with
 * `backend_unavailable` when they are there but the server never came up. In
 * both failure paths nothing is left running.
 */
export const startManagedXSession = (
  dependencies: ManagedXSessionDependencies,
  spec: ManagedXSessionSpec,
  taken: ReadonlySet<number>,
): Effect.Effect<ManagedXSession, OpenbotComputerError> =>
  Effect.gen(function* () {
    const { spawner, fileSystem, tools, baseEnvironment } = dependencies;
    const xvfb = tools.Xvfb;
    const openbox = tools.openbox;
    const xdpyinfo = tools.xdpyinfo;
    if (xvfb === null || openbox === null || xdpyinfo === null) {
      return yield* setupRequired(
        "A managed X session needs Xvfb, openbox, and xdpyinfo, and at least one of them is not installed on this host.",
      );
    }

    const displayNumber = yield* allocateDisplayNumber(fileSystem, taken);
    const display = `:${displayNumber}`;
    const environment = { ...baseEnvironment, DISPLAY: display };
    const requestedWidthPx = spec.widthPx ?? DEFAULT_MANAGED_WIDTH_PX;
    const requestedHeightPx = spec.heightPx ?? DEFAULT_MANAGED_HEIGHT_PX;

    const scope = yield* Scope.make("sequential");
    // Stop order is the reverse of this list: apps, then openbox, then Xvfb.
    // Killing the X server first makes every client above it die on an IO
    // error instead of exiting, which leaves noise and sometimes zombies.
    const childrenRef = yield* Ref.make<ReadonlyArray<ChildProcessSpawner.ChildProcessHandle>>([]);
    const stoppedRef = yield* Ref.make(false);
    const xvfbErrorsRef = yield* Ref.make("");

    const spawn = (executable: string, args: ReadonlyArray<string>) =>
      spawner
        .spawn(
          ChildProcess.make(executable, [...args], {
            ...KILL_OPTIONS,
            env: { ...environment },
            shell: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tap((child) => Ref.update(childrenRef, (children) => [...children, child])),
          Effect.mapError((cause) =>
            backendUnavailable(`Could not start ${executable} for ${display}: ${String(cause)}`),
          ),
        );

    const stop = Effect.gen(function* () {
      const alreadyStopped = yield* Ref.getAndSet(stoppedRef, true);
      if (alreadyStopped) return;
      const children = yield* Ref.get(childrenRef);
      for (const child of children.toReversed()) yield* stopChild(child);
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    });

    const xvfbChild = yield* spawn(
      xvfb,
      xvfbArgs(displayNumber, requestedWidthPx, requestedHeightPx),
    );
    // Xvfb's complaint about a busy display number or a missing extension only
    // reaches stderr, and only while it is still running, so it is collected
    // as it arrives rather than read after the fact.
    yield* Effect.forkIn(
      xvfbChild.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((text) =>
          Ref.update(xvfbErrorsRef, (current) => (current + text).slice(0, MAX_STDERR_BYTES)),
        ),
        Effect.ignore,
      ),
      scope,
    );

    const abandon = (error: OpenbotComputerError) => stop.pipe(Effect.andThen(Effect.fail(error)));

    const probeScreen = Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(xdpyinfo, [], {
          env: { ...environment },
          shell: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [collectUint8StreamText({ stream: child.stdout }), child.exitCode],
        { concurrency: "unbounded" },
      );
      return Number(exitCode) === 0 ? parseXdpyinfoScreen(stdout.text) : null;
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null),
    );

    const deadlineMs = (yield* Clock.currentTimeMillis) + Duration.toMillis(READY_TIMEOUT);
    const screen = yield* Effect.gen(function* () {
      for (;;) {
        const found = yield* probeScreen;
        if (found !== null) return found;
        if ((yield* Clock.currentTimeMillis) >= deadlineMs) return null;
        yield* Effect.sleep(READY_POLL_INTERVAL);
      }
    });

    if (screen === null) {
      const stderr = (yield* Ref.get(xvfbErrorsRef)).trim();
      const suffix = stderr.length > 0 ? `: ${stderr.split("\n")[0] ?? ""}` : ".";
      return yield* abandon(
        backendUnavailable(
          `Xvfb ${display} did not answer within ${Duration.toSeconds(READY_TIMEOUT)} seconds${suffix}`,
        ),
      );
    }

    yield* spawn(openbox, []).pipe(Effect.catch(abandon));
    yield* Effect.sleep(WINDOW_MANAGER_SETTLE);

    const createdAtMs = yield* Clock.currentTimeMillis;
    return {
      displayNumber,
      display,
      name: spec.name ?? `Managed X session ${display}`,
      widthPx: screen.widthPx,
      heightPx: screen.heightPx,
      createdAtMs,
      launch: (executable, args) =>
        spawn(executable, args).pipe(Effect.map((child) => Number(child.pid))),
      stop,
    } satisfies ManagedXSession;
  });
