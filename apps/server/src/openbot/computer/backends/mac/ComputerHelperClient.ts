import { OpenbotComputerError } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeOS from "node:os";

import { ComputerHelperBinary } from "./ComputerHelperBinary.ts";
import {
  COMPUTER_HELPER_PROTOCOL_VERSION,
  decodeHelperReadyRecord,
  decodeHelperRecord,
  emptyRecordDecoderState,
  encodeHelperCommand,
  feedRecordDecoder,
  type HelperCommand,
  type HelperFrameEnvelope,
  type HelperPermissions,
  type HelperRecord,
} from "./ComputerHelperProtocol.ts";

/**
 * A supervised connection to the macOS helper app. One helper runs at a time;
 * the supervisor restarts it with backoff, correlates replies to requests by
 * id, and republishes the helper's unsolicited frames and events.
 *
 * The helper starts on demand, not at layer build. Launching it opens an app in
 * the user's login session, so nothing may happen until someone actually asks
 * about the computer, and a Mac that has no helper installed must stay silent
 * rather than retry a launch it can never complete.
 */

const HANDSHAKE_TIMEOUT = Duration.seconds(10);
const REQUEST_TIMEOUT = Duration.seconds(10);
/** Screen capture and virtual display creation both wait on the window server. */
const SLOW_REQUEST_TIMEOUT = Duration.seconds(30);
const SLOW_COMMANDS: ReadonlySet<string> = new Set(["screenshot", "create-display"]);
/** Typing is paced at the helper end — 15ms between key phases, measured, since
    a faster string loses characters — so a long `text` event honestly takes
    minutes. A flat deadline would report failure while the helper was still
    typing, and the batch would keep going after the caller gave up. */
const INPUT_TIMEOUT_PER_TEXT_CHARACTER = Duration.millis(40);
/** A full batch of full text events is hours of typing at that rate. Past this
    the helper is the wrong thing to be waiting on. */
const MAX_INPUT_TIMEOUT = Duration.minutes(10);
const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;
/** How long the supervisor stays quiet after a burst of failures, so a helper
    that cannot start does not relaunch its app window every few seconds. */
const FAILURE_COOLDOWN = Duration.minutes(1);
/** Frames are the freshest thing on the wire; a slow subscriber gets the
    newest frames rather than a backlog of stale ones. */
const FRAME_BUFFER = 4;
const EVENT_BUFFER = 8;

const READY_POLL_INTERVAL = Duration.millis(100);
const READY_POLL_ATTEMPTS = 100;
/** A Unix domain socket path must fit in ~104 bytes on macOS. */
const MAX_SOCKET_PATH_LENGTH = 100;
const HELPER_TERMINATE_GRACE_MS = 2_000;
const HELPER_TERMINATE_POLL = Duration.millis(100);
const HELPER_TERMINATE_POLL_MS = 100;

export class ComputerHelperUnavailable extends Schema.TaggedErrorClass<ComputerHelperUnavailable>()(
  "ComputerHelperUnavailable",
  {
    reason: Schema.String,
    /** `missing` means the bundle is not on this machine, which retrying cannot
        fix: the supervisor stops and waits to be asked again, by which time the
        helper may have been built. `failed` — the default — covers a helper that
        would not start or one that died, both of which are worth retrying. */
    kind: Schema.Literals(["missing", "failed"]).pipe(
      Schema.withConstructorDefault(Effect.succeed("failed" as const)),
    ),
  },
) {
  override get message(): string {
    return `T3 Computer Helper is unavailable: ${this.reason}`;
  }
}

/** One live byte-duplex to the helper, plus the pid to reap when it dies. */
export interface HelperConnection {
  readonly reads: Stream.Stream<Uint8Array, ComputerHelperUnavailable>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ComputerHelperUnavailable>;
  /** The helper's own pid, when the launcher learned it. */
  readonly pid: number | null;
}

/**
 * Opens one connection for the lifetime of the enclosing scope; releasing the
 * scope must end the helper process it started.
 */
export class ComputerHelperLauncher extends Context.Service<
  ComputerHelperLauncher,
  {
    readonly open: Effect.Effect<HelperConnection, ComputerHelperUnavailable, Scope.Scope>;
  }
>()("t3/openbot/computer/backends/mac/ComputerHelperClient/ComputerHelperLauncher") {}

/** One capture frame the helper pushed up. */
export interface HelperFrame {
  readonly displayId: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly capturedAtMs: number;
  readonly jpeg: Uint8Array;
}

export type HelperEvent = "displays-changed" | "permissions-changed";

/** The helper's answer to `hello`: its pid, bundle, permissions and displays. */
export type HelperHelloRecord = Extract<HelperRecord, { readonly type: "hello" }>;

type HelperFrameRecord = Extract<HelperRecord, { readonly type: "frame" }>;

type OmitId<C> = C extends unknown ? Omit<C, "id"> : never;

/** A command as callers write it: the client assigns the correlation id. */
export type HelperCommandWithoutId = OmitId<HelperCommand>;

export class ComputerHelperClient extends Context.Service<
  ComputerHelperClient,
  {
    /** Sends one command and resolves with its reply record. Starts the helper
        if nothing has yet, waiting out the handshake. A helper `error` record
        for this id fails the effect with the mapped OpenbotComputerError. */
    readonly request: (
      command: HelperCommandWithoutId,
    ) => Effect.Effect<HelperRecord, OpenbotComputerError>;
    /** The reply to a screenshot command, with its JPEG payload attached. */
    readonly requestFrame: (
      command: HelperCommandWithoutId,
    ) => Effect.Effect<HelperFrame, OpenbotComputerError>;
    /** Unsolicited capture frames from every display. Subscribing does not start
        the helper; frames only arrive once something else has. Subscribers that
        fall behind drop old frames rather than growing a backlog. */
    readonly frames: Stream.Stream<HelperFrame>;
    readonly events: Stream.Stream<HelperEvent>;
    /** Readiness: the handshake that proves a helper is up, starting it on the
        first call and after a start that stopped for good. Fails with the reason
        there is no helper. The record is the one the helper sent when it
        connected, so read `permissions` for grants rather than this. */
    readonly hello: Effect.Effect<HelperHelloRecord, OpenbotComputerError>;
    /** What macOS grants the helper *now*. Answered from the last `hello` reply
        while that is still true, and by asking the helper again once it has
        reported a `permissions-changed`, so a grant made in System Settings
        shows up without restarting anything. */
    readonly permissions: Effect.Effect<HelperPermissions, OpenbotComputerError>;
  }
>()("t3/openbot/computer/backends/mac/ComputerHelperClient") {}

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder();

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

/**
 * Signals one pid we launched ourselves. Returns false when the process is
 * already gone. Never resolves a pid by name or command line: this is only
 * ever the pid the helper reported in its own ready file.
 */
function signalHelper(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal === 0 ? 0 : signal);
    return true;
  } catch {
    return false;
  }
}

const terminateHelper = (pid: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const signalled = yield* Effect.sync(() => signalHelper(pid, "SIGTERM"));
    if (!signalled) return;
    for (let waited = 0; waited < HELPER_TERMINATE_GRACE_MS; waited += HELPER_TERMINATE_POLL_MS) {
      yield* Effect.sleep(HELPER_TERMINATE_POLL);
      const alive = yield* Effect.sync(() => signalHelper(pid, 0));
      if (!alive) return;
    }
    yield* Effect.sync(() => signalHelper(pid, "SIGKILL"));
  });

const unavailable = (reason: string) => new ComputerHelperUnavailable({ reason });

/** A `ComputerHelperBinary.resolve` failure: there is no helper to launch. */
const helperMissing = (cause: { readonly message: string }) =>
  new ComputerHelperUnavailable({ reason: cause.message, kind: "missing" });

const isHelperUnavailable = Schema.is(ComputerHelperUnavailable);

const unavailableFrom = (label: string) => (cause: { readonly message: string }) =>
  unavailable(`${label}: ${cause.message}`);

/**
 * Reads the helper's ready file until it parses, or gives up after ten
 * seconds. Sleeping through `Effect.sleep` keeps the deadline testable.
 */
const awaitReadyRecord = (fileSystem: FileSystem.FileSystem, readyPath: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt <= READY_POLL_ATTEMPTS; attempt++) {
      const contents = yield* fileSystem.readFileString(readyPath).pipe(Effect.option);
      if (Option.isSome(contents)) {
        const decoded = decodeHelperReadyRecord(contents.value);
        if (Result.isSuccess(decoded)) return decoded.success;
      }
      if (attempt < READY_POLL_ATTEMPTS) yield* Effect.sleep(READY_POLL_INTERVAL);
    }
    return yield* unavailable(
      "T3 Computer Helper did not report that it was ready within 10 seconds. Open the app once from Finder to confirm macOS is not blocking it.",
    );
  });

/**
 * Consumes the transport-level `auth-ok` line and returns whatever bytes
 * arrived behind it, so the record stream starts at the first real record.
 */
const authenticate = (inbound: Queue.Dequeue<Uint8Array, ComputerHelperUnavailable | Cause.Done>) =>
  Effect.gen(function* () {
    let buffer: Uint8Array = new Uint8Array(0);
    while (true) {
      const newline = buffer.indexOf(10);
      if (newline >= 0) {
        const line = textDecoder.decode(buffer.subarray(0, newline));
        const record = decodeHelperRecord(line);
        if (Result.isFailure(record)) {
          return yield* unavailable(
            `the helper's first line was not a record: ${record.failure.reason}`,
          );
        }
        if (record.success.type !== "auth-ok") {
          return yield* unavailable(
            `the helper answered '${record.success.type}' instead of accepting the connection token`,
          );
        }
        return buffer.slice(newline + 1);
      }
      const chunk = yield* Queue.take(inbound).pipe(
        Effect.mapError((error) =>
          isHelperUnavailable(error)
            ? error
            : unavailable("the helper closed the socket before accepting the connection token"),
        ),
      );
      buffer = concatBytes(buffer, chunk);
    }
  }).pipe(
    Effect.timeoutOption(HANDSHAKE_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(unavailable("the helper did not accept the connection token")),
        onSome: Effect.succeed,
      }),
    ),
  );

const connectHelperSocket = (options: {
  readonly socketPath: string;
  readonly token: string;
  readonly pid: number;
}) =>
  Effect.gen(function* () {
    const socket = yield* NodeSocket.makeNet({ path: options.socketPath });
    const inbound = yield* Queue.unbounded<Uint8Array, ComputerHelperUnavailable | Cause.Done>();
    yield* socket
      .run((bytes) => Queue.offer(inbound, bytes))
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Queue.fail(inbound, unavailable(`the helper socket failed: ${error.message}`)),
          onSuccess: () => Queue.end(inbound),
        }),
        Effect.forkScoped,
      );
    const writer = yield* socket.writer;
    const write = (bytes: Uint8Array) =>
      writer(bytes).pipe(Effect.mapError(unavailableFrom("could not write to the helper socket")));
    yield* write(encodeHelperCommand({ type: "auth", token: options.token }));
    const remainder = yield* authenticate(inbound);
    return {
      reads: Stream.concat(Stream.make(remainder), Stream.fromQueue(inbound)),
      write,
      pid: options.pid,
    } satisfies HelperConnection;
  });

/**
 * The Mac product path.
 *
 * macOS does not attribute a TCC prompt to the process that asked; it walks up
 * to the *responsible* process. A helper spawned as a child of the T3 server is
 * therefore attributed to whatever started the server — an SSH session,
 * `tailscaled`, a terminal emulator — so the Screen Recording and Accessibility
 * grants land on an entry the user cannot find, and move again the next time
 * the server starts differently. Launching through Launch Services (`open -n
 * -a`) makes the helper its own responsible process, so both grants attach to
 * the helper's bundle id and the user grants them exactly once.
 *
 * The connection itself is a Unix socket in a scoped temp directory with a
 * per-launch token, because Launch Services gives us no stdio to the app.
 */
export const loginSessionLauncherLayer = Layer.effect(
  ComputerHelperLauncher,
  Effect.gen(function* () {
    const binary = yield* ComputerHelperBinary;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const open = Effect.gen(function* () {
      const location = yield* binary.resolve.pipe(Effect.mapError(helperMissing));
      if (location.appPath === null) {
        return yield* unavailable(
          "T3 Computer Helper was overridden to a bare executable. macOS can only attach screen and input permissions to an app bundle, so set T3CODE_COMPUTER_HELPER_LAUNCH=child to run it as a child process instead.",
        );
      }
      const directory = yield* fileSystem
        .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix: "t3-computer-helper-" })
        .pipe(Effect.mapError(unavailableFrom("could not create the helper's socket directory")));
      const socketPath = path.join(directory, "helper.sock");
      if (socketPath.length > MAX_SOCKET_PATH_LENGTH) {
        return yield* unavailable(
          `the helper's socket path '${socketPath}' is ${socketPath.length} characters, longer than the ${MAX_SOCKET_PATH_LENGTH} a Unix socket allows. Set TMPDIR to a shorter directory.`,
        );
      }
      const readyPath = path.join(directory, "ready.json");
      const token = toHex(
        yield* crypto
          .randomBytes(16)
          .pipe(Effect.mapError(unavailableFrom("could not mint a helper connection token"))),
      );

      const command = ChildProcess.make(
        "/usr/bin/open",
        [
          "-n",
          "-a",
          location.appPath,
          "--args",
          "--socket",
          socketPath,
          "--token",
          token,
          "--ready-file",
          readyPath,
          "--exit-on-disconnect",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const handle = yield* spawner
        .spawn(command)
        .pipe(Effect.mapError(unavailableFrom("could not run /usr/bin/open")));
      const stderrText = yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.orElseSucceed(() => ""),
      );
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError(unavailableFrom("could not wait for /usr/bin/open")),
      );
      if (Number(exitCode) !== 0) {
        // The token is in this process's argv, never in a message we surface.
        const detail = stderrText.replaceAll(token, "***").trim();
        return yield* unavailable(
          `/usr/bin/open could not start '${location.appPath}' (exit ${Number(exitCode)})${detail === "" ? "" : `: ${detail}`}`,
        );
      }

      const ready = yield* awaitReadyRecord(fileSystem, readyPath);
      yield* Effect.addFinalizer(() => terminateHelper(ready.pid));
      return yield* connectHelperSocket({ socketPath, token, pid: ready.pid });
    });

    return ComputerHelperLauncher.of({ open });
  }),
);

/**
 * The diagnostic path: the helper as an ordinary child process speaking the
 * same protocol over stdio. Selected by `T3CODE_COMPUTER_HELPER_LAUNCH=child`.
 * Permissions granted to a helper started this way belong to whatever started
 * the server, so this is for development and tests, not for users.
 */
export const childLauncherLayer = Layer.effect(
  ComputerHelperLauncher,
  Effect.gen(function* () {
    const binary = yield* ComputerHelperBinary;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const open = Effect.gen(function* () {
      const location = yield* binary.resolve.pipe(Effect.mapError(helperMissing));
      const command = ChildProcess.make(location.executablePath, ["--stdio"], {
        stdin: { stream: "pipe", endOnDone: false },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      });
      const handle = yield* spawner
        .spawn(command)
        .pipe(Effect.mapError(unavailableFrom(`could not start '${location.executablePath}'`)));
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          line.trim() === "" ? Effect.void : Effect.logDebug("T3 Computer Helper", { line }),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
      return {
        reads: handle.stdout.pipe(
          Stream.mapError(unavailableFrom("could not read from the helper")),
        ),
        write: (bytes: Uint8Array) =>
          Stream.run(Stream.make(bytes), handle.stdin).pipe(
            Effect.mapError(unavailableFrom("could not write to the helper")),
          ),
        pid: Number(handle.pid),
      } satisfies HelperConnection;
    });

    return ComputerHelperLauncher.of({ open });
  }),
);

/** Login-session launch on macOS, unless the environment asks for the child
    process path. Every other platform only has the child path to offer. */
export const launcherLayer = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    return environment.T3CODE_COMPUTER_HELPER_LAUNCH === "child" || platform !== "darwin"
      ? childLauncherLayer
      : loginSessionLauncherLayer;
  }),
);

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * SAFETY: `HelperCommandWithoutId` is the same union with `id` removed from
 * every member, so restoring `id` reconstructs the original member. TypeScript
 * cannot see that through the distributed `Omit`.
 */
const withCommandId = (command: HelperCommandWithoutId, id: number): HelperCommand =>
  ({ ...command, id }) as HelperCommand;

function recordId(record: HelperRecord): number | null {
  return "id" in record && typeof record.id === "number" ? record.id : null;
}

function toHelperFrame(record: HelperFrameRecord, jpeg: Uint8Array): HelperFrame {
  return {
    displayId: record.displayId,
    widthPx: record.widthPx,
    heightPx: record.heightPx,
    capturedAtMs: record.capturedAtMs,
    jpeg,
  };
}

/**
 * How long to wait for one command's reply. Input scales with the text it
 * carries, because the helper types it at a fixed pace and the reply only comes
 * once the batch has finished; everything else answers promptly or not at all.
 */
export function helperRequestTimeout(command: HelperCommandWithoutId): Duration.Duration {
  if (command.type === "input") {
    const characters = command.events.reduce(
      (total, event) => (event.type === "text" ? total + event.text.length : total),
      0,
    );
    return Duration.min(
      Duration.sum(REQUEST_TIMEOUT, Duration.times(INPUT_TIMEOUT_PER_TEXT_CHARACTER, characters)),
      MAX_INPUT_TIMEOUT,
    );
  }
  return SLOW_COMMANDS.has(command.type) ? SLOW_REQUEST_TIMEOUT : REQUEST_TIMEOUT;
}

function backendUnavailable(message: string): OpenbotComputerError {
  return new OpenbotComputerError({ code: "backend_unavailable", message });
}

function restartDelay(attempt: number): Duration.Duration {
  return Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);
}

/** Drops failures older than the window so an isolated crash restarts from the
    initial backoff instead of inheriting an ancient burst. */
export function retainRecentHelperFailures(
  failures: ReadonlyArray<number>,
  now: number,
): ReadonlyArray<number> {
  return failures.filter((failedAt) => now - failedAt <= FAILURE_WINDOW_MS);
}

interface ActiveConnection {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ComputerHelperUnavailable>;
}

type ReplyDeferred = Deferred.Deferred<HelperFrameEnvelope, OpenbotComputerError>;
type HelloDeferred = Deferred.Deferred<HelperHelloRecord, ComputerHelperUnavailable>;

export const make = Effect.fn("openbot.computer.computerHelperClient.make")(function* () {
  const launcher = yield* ComputerHelperLauncher;
  // The supervisor outlives the call that asked for the helper, so it is forked
  // into the service's own scope rather than into whichever caller started it.
  const serviceScope = yield* Effect.scope;

  const nextId = yield* Ref.make(1);
  const pending = yield* Ref.make(new Map<number, ReplyDeferred>());
  const frames = yield* PubSub.sliding<HelperFrame>(FRAME_BUFFER);
  const events = yield* PubSub.sliding<HelperEvent>(EVENT_BUFFER);
  const connection = yield* Ref.make(Option.none<ActiveConnection>());
  // The grants the helper last reported. `None` means nobody knows: no helper
  // has answered yet, or one told us they changed and what we held is a lie.
  const knownPermissions = yield* Ref.make(Option.none<HelperPermissions>());
  // `None` means no handshake is in flight, so callers answer with the reason
  // the last attempt failed instead of waiting on a connection nobody is making.
  const helloReady = yield* Ref.make(Option.none<HelloDeferred>());
  const lastError = yield* Ref.make("the helper has not been started");
  /** False until the first caller asks for the helper, and again once the
      supervisor stops for a reason a timer cannot fix. */
  const supervising = yield* Ref.make(false);
  const startMutex = yield* Semaphore.make(1);
  const writeMutex = yield* Semaphore.make(1);
  // Every session re-describes the computer when permissions change, so the
  // refreshes arrive together; the first one asks and the rest read its answer.
  const permissionsMutex = yield* Semaphore.make(1);

  const failPending = (reason: string) =>
    Effect.gen(function* () {
      const outstanding = yield* Ref.getAndSet(pending, new Map<number, ReplyDeferred>());
      yield* Effect.forEach(
        outstanding.values(),
        (deferred) => Deferred.fail(deferred, backendUnavailable(`T3 Computer Helper ${reason}.`)),
        { discard: true },
      );
    });

  /** Sends one command down a connection the caller already holds, and waits
      for the reply the reader fiber correlates back to it. */
  const sendEnvelope = (
    active: ActiveConnection,
    command: HelperCommandWithoutId,
  ): Effect.Effect<HelperFrameEnvelope, OpenbotComputerError> =>
    Effect.gen(function* () {
      const id = yield* Ref.modify(nextId, (current) => [current, current + 1]);
      const deferred = yield* Deferred.make<HelperFrameEnvelope, OpenbotComputerError>();
      yield* Ref.update(pending, (map) => new Map(map).set(id, deferred));
      const timeout = helperRequestTimeout(command);
      return yield* writeMutex
        .withPermits(1)(active.write(encodeHelperCommand(withCommandId(command, id))))
        .pipe(
          Effect.mapError((error) =>
            backendUnavailable(`T3 Computer Helper is unavailable: ${error.reason}`),
          ),
          Effect.andThen(
            Deferred.await(deferred).pipe(
              Effect.timeoutOption(timeout),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      backendUnavailable(
                        `T3 Computer Helper did not answer '${command.type}' within ${Math.round(Duration.toSeconds(timeout))} seconds.`,
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.ensuring(
            Ref.update(pending, (map) => {
              const next = new Map(map);
              next.delete(id);
              return next;
            }),
          ),
        );
    });

  const handleEnvelope = (envelope: HelperFrameEnvelope) =>
    Effect.gen(function* () {
      const record = envelope.record;
      if (record.type === "event") {
        // Forgotten before the event goes out, so a subscriber that describes
        // the computer on hearing it cannot read the superseded grants.
        if (record.event === "permissions-changed") {
          yield* Ref.set(knownPermissions, Option.none());
        }
        yield* PubSub.publish(events, record.event);
        return;
      }
      // Every `hello` reply carries the grants as they were when the helper
      // answered — the handshake's and any later refresh's alike.
      if (record.type === "hello") {
        yield* Ref.set(knownPermissions, Option.some(record.permissions));
      }
      const id = recordId(record);
      if (id !== null) {
        const deferred = yield* Ref.modify(pending, (map) => {
          const found = map.get(id);
          if (found === undefined) return [Option.none<ReplyDeferred>(), map] as const;
          const next = new Map(map);
          next.delete(id);
          return [Option.some(found), next] as const;
        });
        if (Option.isNone(deferred)) return;
        yield* record.type === "error"
          ? Deferred.fail(
              deferred.value,
              new OpenbotComputerError({ code: record.code, message: record.message }),
            )
          : Deferred.succeed(deferred.value, envelope);
        return;
      }
      if (record.type === "frame") {
        if (envelope.payload === null) return;
        yield* PubSub.publish(frames, toHelperFrame(record, envelope.payload));
        return;
      }
      if (record.type === "error") {
        yield* Effect.logWarning("T3 Computer Helper reported an error with no request", {
          code: record.code,
        });
      }
    });

  const runAttempt: Effect.Effect<void, ComputerHelperUnavailable> = Effect.scoped(
    Effect.gen(function* () {
      const fresh = yield* Deferred.make<HelperHelloRecord, ComputerHelperUnavailable>();
      const ready = yield* Ref.modify(helloReady, (current) =>
        Option.isSome(current) ? [current.value, current] : [fresh, Option.some(fresh)],
      );
      const active = yield* launcher.open;
      const outbound: ActiveConnection = { write: active.write };
      yield* Ref.set(connection, Option.some(outbound));
      const decoderState = yield* Ref.make(emptyRecordDecoderState);

      const readFiber = yield* active.reads.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const state = yield* Ref.get(decoderState);
            const fed = feedRecordDecoder(state, chunk);
            if (Result.isFailure(fed)) {
              return yield* unavailable(
                `the helper sent an undecodable record: ${fed.failure.reason}`,
              );
            }
            yield* Ref.set(decoderState, fed.success.state);
            yield* Effect.forEach(fed.success.records, handleEnvelope, { discard: true });
          }),
        ),
        Effect.forkScoped,
      );

      const connectionEnded = Fiber.join(readFiber).pipe(
        Effect.andThen(Effect.fail(unavailable("the helper closed its connection"))),
      );
      // The handshake writes straight to the connection it just opened, so it
      // never waits on the readiness it is the one to publish.
      const handshake = Effect.gen(function* () {
        const reply = yield* sendEnvelope(outbound, {
          type: "hello",
          protocolVersion: COMPUTER_HELPER_PROTOCOL_VERSION,
        }).pipe(Effect.mapError((error) => unavailable(error.message)));
        if (reply.record.type !== "hello") {
          return yield* unavailable(`the helper replied with '${reply.record.type}' to 'hello'`);
        }
        yield* Deferred.succeed(ready, reply.record);
        return yield* Effect.never;
      });

      return yield* Effect.raceFirst(connectionEnded, handshake);
    }),
    // A dead helper's grants are nobody's grants: dropping them here is what
    // makes a relaunched helper's handshake replace the old ones rather than
    // sit behind them.
  ).pipe(
    Effect.ensuring(
      Ref.set(connection, Option.none()).pipe(
        Effect.andThen(Ref.set(knownPermissions, Option.none())),
      ),
    ),
  );

  /**
   * Keeps one helper running until the service scope closes, restarting it with
   * backoff after a crash. A helper that was never there is not restarted at
   * all: the loop stops so nothing relaunches on a timer, and the next caller
   * re-arms it through `ensureStarted`.
   */
  const supervise = Effect.gen(function* () {
    let failures: ReadonlyArray<number> = [];
    let restartAttempt = 0;

    while (true) {
      const result = yield* Effect.result(runAttempt);
      if (Result.isSuccess(result)) return yield* Ref.set(supervising, false);

      const error = result.failure;
      const terminal = error.kind === "missing";
      yield* Ref.set(lastError, error.reason);
      // Stand down before waking anyone, so a caller that fails on this error
      // and immediately asks again gets a fresh attempt rather than silence.
      if (terminal) yield* Ref.set(supervising, false);
      const waiting = yield* Ref.getAndSet(helloReady, Option.none<HelloDeferred>());
      if (Option.isSome(waiting)) yield* Deferred.fail(waiting.value, error);
      yield* failPending(`is unavailable: ${error.reason}`);
      if (terminal) return;

      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const recent = retainRecentHelperFailures(failures, now);
      if (recent.length === 0) restartAttempt = 0;
      failures = [...recent, now];

      if (failures.length >= MAX_FAILURES_PER_WINDOW) {
        yield* Effect.logWarning("T3 Computer Helper keeps failing; pausing restarts", {
          reason: error.reason,
        });
        yield* Effect.sleep(FAILURE_COOLDOWN);
        failures = [];
        restartAttempt = 0;
        continue;
      }

      yield* Effect.sleep(restartDelay(restartAttempt));
      restartAttempt += 1;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("T3 Computer Helper supervisor stopped unexpectedly").pipe(
            Effect.andThen(Ref.set(lastError, "its supervisor stopped unexpectedly")),
            Effect.andThen(Ref.set(supervising, false)),
          ),
    ),
  );

  /**
   * Launches the helper on demand. Returns the handshake to wait on, or `None`
   * when an attempt is already under way and has nothing to await yet — a
   * restart still inside its backoff, for instance.
   */
  const ensureStarted: Effect.Effect<Option.Option<HelloDeferred>> = startMutex.withPermits(1)(
    Effect.gen(function* () {
      if (yield* Ref.get(supervising)) return yield* Ref.get(helloReady);
      const ready = yield* Deferred.make<HelperHelloRecord, ComputerHelperUnavailable>();
      yield* Ref.set(helloReady, Option.some(ready));
      yield* Ref.set(supervising, true);
      yield* Effect.forkIn(supervise, serviceScope);
      return Option.some(ready);
    }),
  );

  const downNow: Effect.Effect<never, OpenbotComputerError> = Ref.get(lastError).pipe(
    Effect.flatMap((reason) =>
      Effect.fail(backendUnavailable(`T3 Computer Helper is unavailable: ${reason}`)),
    ),
  );

  /** The live connection, starting the helper and waiting out its handshake
      when this is the first thing anyone asked of it. */
  const connected: Effect.Effect<ActiveConnection, OpenbotComputerError> = Effect.gen(function* () {
    const active = yield* Ref.get(connection);
    if (Option.isSome(active)) return active.value;
    const ready = yield* ensureStarted;
    if (Option.isSome(ready)) {
      yield* Deferred.await(ready.value).pipe(
        Effect.timeoutOption(HANDSHAKE_TIMEOUT),
        Effect.ignore,
      );
      const reconnected = yield* Ref.get(connection);
      if (Option.isSome(reconnected)) return reconnected.value;
    }
    return yield* downNow;
  });

  const requestEnvelope = (
    command: HelperCommandWithoutId,
  ): Effect.Effect<HelperFrameEnvelope, OpenbotComputerError> =>
    connected.pipe(Effect.flatMap((active) => sendEnvelope(active, command)));

  const request: ComputerHelperClient["Service"]["request"] = (command) =>
    requestEnvelope(command).pipe(Effect.map((envelope) => envelope.record));

  const requestFrame: ComputerHelperClient["Service"]["requestFrame"] = (command) =>
    requestEnvelope(command).pipe(
      Effect.flatMap((envelope) =>
        envelope.record.type === "frame" && envelope.payload !== null
          ? Effect.succeed(toHelperFrame(envelope.record, envelope.payload))
          : Effect.fail(
              backendUnavailable(
                `T3 Computer Helper replied with '${envelope.record.type}' to '${command.type}'.`,
              ),
            ),
      ),
    );

  const hello: ComputerHelperClient["Service"]["hello"] = Effect.gen(function* () {
    const ready = yield* ensureStarted;
    if (Option.isSome(ready)) {
      const settled = yield* Deferred.await(ready.value).pipe(
        Effect.timeoutOption(HANDSHAKE_TIMEOUT),
        Effect.catchTag("ComputerHelperUnavailable", () =>
          Effect.succeed(Option.none<HelperHelloRecord>()),
        ),
      );
      if (Option.isSome(settled)) return settled.value;
    }
    return yield* downNow;
  });

  /**
   * `hello` is the only command that reports permissions, and the helper answers
   * it from a fresh read of both gates every time, so re-asking is how the
   * server learns about a grant. It is asked only when nothing current is
   * remembered, which after a handshake or a change is at most once.
   */
  const permissions: ComputerHelperClient["Service"]["permissions"] = permissionsMutex.withPermits(
    1,
  )(
    Effect.gen(function* () {
      const remembered = yield* Ref.get(knownPermissions);
      if (Option.isSome(remembered)) return remembered.value;
      const active = yield* connected;
      // Connecting runs a handshake, whose reply is already an answer.
      const handshaken = yield* Ref.get(knownPermissions);
      if (Option.isSome(handshaken)) return handshaken.value;
      const reply = yield* sendEnvelope(active, {
        type: "hello",
        protocolVersion: COMPUTER_HELPER_PROTOCOL_VERSION,
      });
      if (reply.record.type !== "hello") {
        return yield* Effect.fail(
          backendUnavailable(`T3 Computer Helper replied with '${reply.record.type}' to 'hello'.`),
        );
      }
      return reply.record.permissions;
    }),
  );

  return ComputerHelperClient.of({
    request,
    requestFrame,
    frames: Stream.fromPubSub(frames),
    events: Stream.fromPubSub(events),
    hello,
    permissions,
  });
});

export const layer = Layer.effect(ComputerHelperClient, make());
