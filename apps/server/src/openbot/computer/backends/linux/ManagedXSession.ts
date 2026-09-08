import { OpenbotComputerError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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

/** How long the X server gets to claim a display and answer before the session
    is abandoned. */
export const READY_TIMEOUT = Duration.seconds(15);
const READY_POLL_INTERVAL = Duration.millis(200);
/** A window manager that has not finished mapping its root window drops the
    first app's window on the floor, so startup waits this out rather than
    letting the first launch race it. */
const WINDOW_MANAGER_SETTLE = Duration.millis(400);
/** Long enough for an X server to flush and exit cleanly, short enough that a
    wedged one does not hold up shutdown. */
export const FORCE_KILL_AFTER = Duration.seconds(3);
/** Xvfb's stdout, which carries nothing else: the display number it claimed is
    written there as one line and is the only thing we read from the child. */
const XVFB_DISPLAY_FD = 1;

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
  readonly tools: LinuxToolPaths;
  /** What the tools inherit. `DISPLAY` is always replaced with this session's. */
  readonly baseEnvironment: Readonly<Record<string, string | undefined>>;
}

const setupRequired = (message: string) =>
  new OpenbotComputerError({ code: "setup_required", message });
const backendUnavailable = (message: string) =>
  new OpenbotComputerError({ code: "backend_unavailable", message });

/**
 * Folds a child's stderr into `ref`, keeping at most `MAX_STDERR_BYTES`.
 *
 * Every child gets one of these or an ignored stderr: a pipe nobody reads fills
 * at around 64 KiB and then blocks the child inside its next write, which for a
 * window manager means a desktop that stops responding for reasons nothing in
 * this process can see.
 */
export const collectStderr = <E>(
  stderr: Stream.Stream<Uint8Array, E>,
  ref: Ref.Ref<string>,
): Effect.Effect<void> =>
  stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Ref.update(ref, (current) =>
        current.length >= MAX_STDERR_BYTES ? current : (current + text).slice(0, MAX_STDERR_BYTES),
      ),
    ),
    Effect.ignore,
  );

/** SIGTERM, then insist. A leaked Xvfb owns a display number the next session
    wants, and a leaked openbox keeps a dead display's windows alive. */
const stopChild = (child: ChildProcessSpawner.ChildProcessHandle) =>
  child.kill(KILL_OPTIONS).pipe(Effect.ignore, Effect.andThen(Effect.ignore(child.exitCode)));

/** The display number Xvfb wrote to `-displayfd`, or null when the line was
    something else. */
const parseDisplayFdLine = (line: string): number | null => {
  const match = /^\s*(\d+)\s*$/u.exec(line);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Starts a managed session and waits until it can actually be used.
 *
 * The display number comes from Xvfb itself: it is the number Xvfb bound, not
 * one we guessed, so two servers starting at the same moment cannot both claim
 * it. `taken` is the numbers this process already manages, and a report of one
 * of those is treated as a failure rather than as a second session sharing a
 * live desktop.
 *
 * Fails with `setup_required` when the host lacks the programs, and with
 * `backend_unavailable` when they are there but the server never came up. Every
 * exit but a successful one stops whatever was started, including interruption
 * partway through; ownership passes to the returned session only on success.
 */
export const startManagedXSession = (
  dependencies: ManagedXSessionDependencies,
  spec: ManagedXSessionSpec,
  taken: ReadonlySet<number>,
): Effect.Effect<ManagedXSession, OpenbotComputerError> =>
  Effect.gen(function* () {
    const { spawner, tools, baseEnvironment } = dependencies;
    const xvfb = tools.Xvfb;
    const openbox = tools.openbox;
    const xdpyinfo = tools.xdpyinfo;
    if (xvfb === null || openbox === null || xdpyinfo === null) {
      return yield* setupRequired(
        "A managed X session needs Xvfb, openbox, and xdpyinfo, and at least one of them is not installed on this host.",
      );
    }

    const requestedWidthPx = spec.widthPx ?? DEFAULT_MANAGED_WIDTH_PX;
    const requestedHeightPx = spec.heightPx ?? DEFAULT_MANAGED_HEIGHT_PX;

    const scope = yield* Scope.make("sequential");
    // Stop order is the reverse of this list: apps, then openbox, then Xvfb.
    // Killing the X server first makes every client above it die on an IO
    // error instead of exiting, which leaves noise and sometimes zombies.
    const childrenRef = yield* Ref.make<ReadonlyArray<ChildProcessSpawner.ChildProcessHandle>>([]);
    const stoppedRef = yield* Ref.make(false);
    const xvfbErrorsRef = yield* Ref.make("");
    const openboxErrorsRef = yield* Ref.make("");

    const spawn = (
      executable: string,
      args: ReadonlyArray<string>,
      options: {
        readonly env: Readonly<Record<string, string | undefined>>;
        readonly stdout: "ignore" | "pipe";
        readonly stderr: "ignore" | "pipe";
      },
    ) =>
      spawner
        .spawn(
          ChildProcess.make(executable, [...args], {
            ...KILL_OPTIONS,
            env: { ...options.env },
            shell: false,
            stdin: "ignore",
            stdout: options.stdout,
            stderr: options.stderr,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tap((child) => Ref.update(childrenRef, (children) => [...children, child])),
          Effect.mapError((cause) =>
            backendUnavailable(`Could not start ${executable}: ${String(cause)}`),
          ),
        );

    const stop = Effect.gen(function* () {
      const alreadyStopped = yield* Ref.getAndSet(stoppedRef, true);
      if (alreadyStopped) return;
      const children = yield* Ref.get(childrenRef);
      for (const child of children.toReversed()) yield* stopChild(child);
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    });

    const startup = Effect.gen(function* () {
      const xvfbChild = yield* spawn(
        xvfb,
        xvfbArgs({
          widthPx: requestedWidthPx,
          heightPx: requestedHeightPx,
          displayFd: XVFB_DISPLAY_FD,
        }),
        { env: baseEnvironment, stdout: "pipe", stderr: "pipe" },
      );
      // Xvfb's complaint about a missing extension or a display it could not
      // bind only reaches stderr, and only while it is still running, so it is
      // collected as it arrives rather than read after the fact.
      const xvfbErrors = yield* Effect.forkIn(
        collectStderr(xvfbChild.stderr, xvfbErrorsRef),
        scope,
      );

      /** Whatever Xvfb said about why it is not working, on one line. */
      const withXvfbStderr = (reason: string): Effect.Effect<never, OpenbotComputerError> =>
        Ref.get(xvfbErrorsRef).pipe(
          Effect.flatMap((collected) => {
            const stderr = collected.trim();
            const suffix = stderr.length > 0 ? `: ${stderr.split("\n")[0] ?? ""}` : ".";
            return Effect.fail(backendUnavailable(`${reason}${suffix}`));
          }),
        );

      /** An Xvfb that exited is a failed startup however far it got, and
          waiting for a display it no longer owns would only time out. */
      const xvfbExited = (reason: string) =>
        xvfbChild.exitCode.pipe(
          Effect.orElseSucceed(() => ChildProcessSpawner.ExitCode(-1)),
          Effect.flatMap((code) =>
            // The explanation is the useful half of this message and is still in
            // flight when the process goes; its pipe closes with the child, so
            // the collector is awaited rather than sampled.
            Fiber.await(xvfbErrors).pipe(
              Effect.ignore,
              Effect.andThen(withXvfbStderr(`${reason} (exit ${Number(code)})`)),
            ),
          ),
        );

      const deadlineMs = (yield* Clock.currentTimeMillis) + Duration.toMillis(READY_TIMEOUT);
      const untilDeadline = <A>(
        effect: Effect.Effect<A, OpenbotComputerError>,
        onTimeout: string,
      ) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowMs) =>
            Effect.timeoutOrElse(effect, {
              duration: Duration.millis(Math.max(0, deadlineMs - nowMs)),
              orElse: () => withXvfbStderr(onTimeout),
            }),
          ),
        );

      const readDisplayNumber = xvfbChild.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.flatMap((lines) => {
          const reported = parseDisplayFdLine(lines[0] ?? "");
          return reported === null
            ? withXvfbStderr("Xvfb reported no display number")
            : Effect.succeed(reported);
        }),
      );

      const displayNumber = yield* untilDeadline(
        Effect.raceFirst(
          readDisplayNumber,
          xvfbExited("Xvfb stopped before it reported a display"),
        ),
        `Xvfb did not report a display within ${Duration.toSeconds(READY_TIMEOUT)} seconds`,
      );

      if (taken.has(displayNumber)) {
        return yield* withXvfbStderr(
          `Xvfb reported display :${displayNumber}, which this server already manages`,
        );
      }

      const display = `:${displayNumber}`;
      const environment = { ...baseEnvironment, DISPLAY: display };

      const probeScreen = Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(xdpyinfo, [], {
            env: { ...environment },
            shell: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            ...KILL_OPTIONS,
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

      const pollUntilReady = Effect.gen(function* () {
        for (;;) {
          const found = yield* probeScreen;
          if (found !== null) return found;
          yield* Effect.sleep(READY_POLL_INTERVAL);
        }
      });

      const screen = yield* untilDeadline(
        Effect.raceFirst(pollUntilReady, xvfbExited(`Xvfb ${display} stopped before it was ready`)),
        `Xvfb ${display} did not answer within ${Duration.toSeconds(READY_TIMEOUT)} seconds`,
      );

      const openboxChild = yield* spawn(openbox, [], {
        env: environment,
        stdout: "ignore",
        stderr: "pipe",
      });
      // Openbox is chatty about X errors for the life of the session and no
      // message of its is worth reporting, but its pipe still has to be read:
      // the collector exists to empty it, and keeps a bounded prefix so a
      // debugger has something to look at.
      yield* Effect.forkIn(collectStderr(openboxChild.stderr, openboxErrorsRef), scope);
      yield* Effect.sleep(WINDOW_MANAGER_SETTLE);

      const createdAtMs = yield* Clock.currentTimeMillis;
      return {
        displayNumber,
        display,
        name: spec.name ?? `Managed X session ${display}`,
        widthPx: screen.widthPx,
        heightPx: screen.heightPx,
        createdAtMs,
        // A launched app's output is its own business, and a pipe nobody reads
        // is a browser that freezes on its first warning.
        launch: (executable, args) =>
          spawn(executable, args, {
            env: environment,
            stdout: "ignore",
            stderr: "ignore",
          }).pipe(Effect.map((child) => Number(child.pid))),
        stop,
      } satisfies ManagedXSession;
    });

    // The children above are owned by `scope`, which nothing else closes until
    // the session hands out its `stop`. Any exit but success — a probe that
    // timed out, an openbox that would not start, an interrupt while polling or
    // settling — releases them here instead of leaking an X server nobody can
    // name any more.
    return yield* startup.pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : stop)),
    );
  });
