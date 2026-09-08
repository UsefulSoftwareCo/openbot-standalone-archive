import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ComputerHelperBinary } from "./ComputerHelperBinary.ts";
import {
  ComputerHelperClient,
  ComputerHelperLauncher,
  ComputerHelperUnavailable,
  childLauncherLayer,
  layer as computerHelperClientLayer,
  loginSessionLauncherLayer,
} from "./ComputerHelperClient.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GRANTED = { screenCapture: "granted", accessibility: "granted" } as const;

function frameBytes(record: Record<string, unknown>, payload: Uint8Array): Uint8Array {
  const line = encoder.encode(`${JSON.stringify(record)}\n`);
  const merged = new Uint8Array(line.length + payload.length);
  merged.set(line, 0);
  merged.set(payload, line.length);
  return merged;
}

function recordBytes(record: Record<string, unknown>): Uint8Array {
  return encoder.encode(`${JSON.stringify(record)}\n`);
}

interface SentCommand {
  readonly id: number;
  readonly type: string;
}

function parseCommand(bytes: Uint8Array): SentCommand {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (typeof value !== "object" || value === null) {
    throw new Error("helper command was not an object");
  }
  const id = Reflect.get(value, "id");
  const type = Reflect.get(value, "type");
  if (typeof id !== "number" || typeof type !== "string") {
    throw new Error(`helper command was not correlated: ${decoder.decode(bytes)}`);
  }
  return { id, type };
}

interface FakeConnection {
  readonly inbound: Queue.Queue<Uint8Array, Cause.Done>;
  readonly written: Queue.Queue<Uint8Array>;
}

const takeCommand = (connection: FakeConnection) =>
  Queue.take(connection.written).pipe(Effect.map(parseCommand));

const push = (connection: FakeConnection, bytes: Uint8Array) =>
  Queue.offer(connection.inbound, bytes).pipe(Effect.asVoid);

/**
 * Lets a forked subscriber reach its `PubSub` subscription before the test
 * pushes bytes the client will publish. This is a scheduler barrier, not a
 * sleep: the subscribing fiber only needs a few turns to reach its first
 * suspension, and nothing here waits on the clock.
 */
const settle = Effect.forEach(
  Array.from({ length: 20 }, (_, index) => index),
  () => Effect.yieldNow,
  {
    discard: true,
  },
);

interface Harness {
  readonly client: ComputerHelperClient["Service"];
  readonly opened: Queue.Queue<FakeConnection>;
}

/**
 * Substitutes the launcher port with an in-memory duplex the test drives, so
 * every layer above it — supervisor, framing, correlation — is the production
 * one. `opened` receives one entry per launch, which is also how a test sees
 * that nothing launched.
 */
const withHelper = <A, E>(body: (harness: Harness) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const opened = yield* Queue.unbounded<FakeConnection>();
    const launcher = Layer.succeed(
      ComputerHelperLauncher,
      ComputerHelperLauncher.of({
        open: Effect.gen(function* () {
          const inbound = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          const written = yield* Queue.unbounded<Uint8Array>();
          yield* Queue.offer(opened, { inbound, written });
          return {
            reads: Stream.fromQueue(inbound),
            write: (bytes: Uint8Array) => Queue.offer(written, bytes).pipe(Effect.asVoid),
            pid: 4242,
          };
        }),
      }),
    );
    return yield* Effect.gen(function* () {
      const client = yield* ComputerHelperClient;
      return yield* body({ client, opened });
    }).pipe(Effect.provide(computerHelperClientLayer.pipe(Layer.provide(launcher))));
  });

/** Answers the helper's side of the handshake and returns the id it used. */
const answerHello = (connection: FakeConnection, pid: number) =>
  Effect.gen(function* () {
    const command = yield* takeCommand(connection);
    expect(command.type).toBe("hello");
    yield* push(
      connection,
      recordBytes({
        id: command.id,
        type: "hello",
        protocolVersion: 1,
        pid,
        bundleId: "codes.t3.ComputerHelper",
        permissions: GRANTED,
        displays: [],
      }),
    );
    return command;
  });

/**
 * Brings the helper up the way a caller does — by asking for it — and answers
 * the handshake. Nothing connects until something demands the helper, so every
 * test that needs a live connection starts here.
 */
const connect = (harness: Harness, pid = 1) =>
  Effect.gen(function* () {
    const asking = yield* harness.client.hello.pipe(Effect.forkChild);
    const connection = yield* Queue.take(harness.opened);
    yield* answerHello(connection, pid);
    const hello = yield* Fiber.join(asking);
    return { connection, hello };
  });

describe("ComputerHelperClient", () => {
  it.effect("completes the handshake and reports the connected helper", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        const { hello } = yield* connect(harness, 991);

        expect(hello.pid).toBe(991);
        expect(hello.permissions).toEqual(GRANTED);
        // The handshake is answered once and remembered.
        expect((yield* harness.client.hello).pid).toBe(991);
      }),
    ),
  );

  it.effect("does not open the launcher until the first request", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        // Subscribing is not demand: a client that only watches for frames must
        // not open the helper app on a Mac nobody asked to control.
        yield* harness.client.frames.pipe(Stream.runDrain, Effect.forkChild);
        yield* harness.client.events.pipe(Stream.runDrain, Effect.forkChild);
        yield* settle;
        yield* TestClock.adjust(Duration.minutes(5));

        expect(yield* Queue.size(harness.opened)).toBe(0);

        const displays = yield* harness.client.request({ type: "displays" }).pipe(Effect.forkChild);
        const connection = yield* Queue.take(harness.opened);
        yield* answerHello(connection, 12);
        const command = yield* takeCommand(connection);
        expect(command.type).toBe("displays");
        yield* push(connection, recordBytes({ id: command.id, type: "displays", displays: [] }));

        expect((yield* Fiber.join(displays)).type).toBe("displays");
      }),
    ),
  );

  it.effect("a missing binary stops the supervisor and the next hello retries exactly once", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const launcher = Layer.succeed(
        ComputerHelperLauncher,
        ComputerHelperLauncher.of({
          open: Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.fail(
                new ComputerHelperUnavailable({
                  reason: "the macOS computer helper is missing",
                  kind: "missing",
                }),
              ),
            ),
          ),
        }),
      );

      yield* Effect.gen(function* () {
        const client = yield* ComputerHelperClient;

        const first = yield* client.hello.pipe(Effect.flip);
        expect(first.code).toBe("backend_unavailable");
        expect(first.message).toContain("the macOS computer helper is missing");
        expect(yield* Ref.get(attempts)).toBe(1);

        // Nothing relaunches on a timer, so a Mac without the helper stays quiet.
        yield* TestClock.adjust(Duration.minutes(30));
        expect(yield* Ref.get(attempts)).toBe(1);

        // The next caller re-arms once, in case the helper was built meanwhile.
        const second = yield* client.hello.pipe(Effect.flip);
        expect(second.code).toBe("backend_unavailable");
        expect(yield* Ref.get(attempts)).toBe(2);
      }).pipe(Effect.provide(computerHelperClientLayer.pipe(Layer.provide(launcher))));
    }),
  );

  it.effect("matches replies to requests when the helper answers out of order", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        const { connection } = yield* connect(harness);
        const client = harness.client;

        const displays = yield* client.request({ type: "displays" }).pipe(Effect.forkChild);
        const windows = yield* client.request({ type: "windows" }).pipe(Effect.forkChild);
        const first = yield* takeCommand(connection);
        const second = yield* takeCommand(connection);
        expect(first.type).toBe("displays");
        expect(second.type).toBe("windows");
        expect(second.id).not.toBe(first.id);

        yield* push(connection, recordBytes({ id: second.id, type: "windows", windows: [] }));
        yield* push(
          connection,
          recordBytes({
            id: first.id,
            type: "displays",
            displays: [
              {
                id: "1",
                name: "Built-in",
                kind: "physical",
                widthPx: 100,
                heightPx: 50,
                scale: 2,
                main: true,
                managed: false,
              },
            ],
          }),
        );

        const displaysRecord = yield* Fiber.join(displays);
        const windowsRecord = yield* Fiber.join(windows);
        expect(displaysRecord.type).toBe("displays");
        expect(windowsRecord.type).toBe("windows");
        if (displaysRecord.type !== "displays") throw new Error("expected a displays record");
        expect(displaysRecord.displays.map((display) => display.name)).toEqual(["Built-in"]);
      }),
    ),
  );

  it.effect("reassembles a capture frame whose payload spans chunk boundaries", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        const { connection } = yield* connect(harness);
        const client = harness.client;

        const received = yield* Queue.unbounded<{
          readonly displayId: string;
          readonly jpeg: Uint8Array;
        }>();
        yield* client.frames.pipe(
          Stream.runForEach((frame) =>
            Queue.offer(received, { displayId: frame.displayId, jpeg: frame.jpeg }),
          ),
          Effect.forkChild,
        );
        yield* settle;

        const jpeg = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const framed = frameBytes(
          {
            type: "frame",
            displayId: "7",
            widthPx: 8,
            heightPx: 4,
            capturedAtMs: 1234,
            payloadBytes: jpeg.length,
          },
          jpeg,
        );
        const split = framed.length - 3;
        yield* push(connection, framed.slice(0, split));
        yield* push(connection, framed.slice(split));

        const frame = yield* Queue.take(received);
        expect(frame.displayId).toBe("7");
        expect(Array.from(frame.jpeg)).toEqual(Array.from(jpeg));
      }),
    ),
  );

  it.effect("fails only the request the helper reported an error for", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        const { connection } = yield* connect(harness);
        const client = harness.client;

        const denied = yield* client
          .request({ type: "windows" })
          .pipe(Effect.flip, Effect.forkChild);
        const survivor = yield* client.request({ type: "displays" }).pipe(Effect.forkChild);
        const deniedCommand = yield* takeCommand(connection);
        const survivorCommand = yield* takeCommand(connection);

        yield* push(
          connection,
          recordBytes({
            id: deniedCommand.id,
            type: "error",
            code: "permission_denied",
            message: "Screen Recording is off.",
          }),
        );
        yield* push(
          connection,
          recordBytes({ id: survivorCommand.id, type: "displays", displays: [] }),
        );

        const error = yield* Fiber.join(denied);
        expect(error.code).toBe("permission_denied");
        expect(error.message).toBe("Screen Recording is off.");
        expect((yield* Fiber.join(survivor)).type).toBe("displays");
      }),
    ),
  );

  it.effect("gives up on a request the helper never answers", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        const { connection } = yield* connect(harness);
        const client = harness.client;

        const pending = yield* client
          .request({ type: "windows" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* takeCommand(connection);

        yield* TestClock.adjust(Duration.seconds(10));

        const error = yield* Fiber.join(pending);
        expect(error.code).toBe("backend_unavailable");
        expect(error.message).toContain("windows");
      }),
    ),
  );

  it.effect("fails pending requests and reconnects when the helper drops the connection", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        const { connection: first } = yield* connect(harness);
        const client = harness.client;

        const pending = yield* client
          .request({ type: "windows" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* takeCommand(first);

        yield* Queue.end(first.inbound);

        const error = yield* Fiber.join(pending);
        expect(error.code).toBe("backend_unavailable");
        expect(error.message).toContain("closed its connection");

        // While no connection is being attempted, asking for the helper says
        // why immediately rather than waiting out the handshake deadline.
        const down = yield* client.hello.pipe(Effect.flip);
        expect(down.code).toBe("backend_unavailable");
        expect(down.message).toContain("closed its connection");

        yield* TestClock.adjust(Duration.millis(500));

        const second = yield* Queue.take(harness.opened);
        const rehello = yield* takeCommand(second);
        expect(rehello.type).toBe("hello");
      }),
    ),
  );

  it.effect("republishes the helper's unsolicited events", () =>
    withHelper((harness) =>
      Effect.gen(function* () {
        const { connection } = yield* connect(harness);
        const client = harness.client;

        const received = yield* Queue.unbounded<string>();
        yield* client.events.pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkChild,
        );
        yield* settle;

        yield* push(connection, recordBytes({ type: "event", event: "displays-changed" }));
        yield* push(connection, recordBytes({ type: "event", event: "permissions-changed" }));

        expect(yield* Queue.take(received)).toBe("displays-changed");
        expect(yield* Queue.take(received)).toBe("permissions-changed");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

const HELPER_APP = "/Applications/T3ComputerHelper.app";
const HELPER_EXECUTABLE = `${HELPER_APP}/Contents/MacOS/T3ComputerHelper`;

const binaryLayer = (appPath: string | null) =>
  Layer.succeed(
    ComputerHelperBinary,
    ComputerHelperBinary.of({
      resolve: Effect.succeed({ appPath, executablePath: HELPER_EXECUTABLE }),
    }),
  );

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const emptyHandle = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(4242),
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  unref: Effect.succeed(Effect.void),
  stdin: Sink.drain,
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
});

const recordingSpawner = (spawned: Queue.Queue<SpawnedCommand>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command: ChildProcess.Command) =>
      command._tag === "StandardCommand"
        ? Queue.offer(spawned, { command: command.command, args: [...command.args] }).pipe(
            Effect.as(emptyHandle),
          )
        : Effect.die("the helper is never launched through a pipeline"),
    ),
  );

describe("childLauncherLayer", () => {
  it.effect("runs the helper executable in stdio mode", () =>
    Effect.gen(function* () {
      const spawned = yield* Queue.unbounded<SpawnedCommand>();

      yield* Effect.gen(function* () {
        const launcher = yield* ComputerHelperLauncher;
        const connection = yield* launcher.open;
        expect(connection.pid).toBe(4242);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          childLauncherLayer.pipe(
            Layer.provide(binaryLayer(HELPER_APP)),
            Layer.provide(recordingSpawner(spawned)),
          ),
        ),
      );

      const command = yield* Queue.take(spawned);
      expect(command.command).toBe(HELPER_EXECUTABLE);
      expect(command.args).toEqual(["--stdio"]);
    }),
  );
});

describe("loginSessionLauncherLayer", () => {
  const fakeCrypto = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(0xab),
      digest: () => Effect.die("the helper launcher does not hash"),
    }),
  );

  /** A host where the temp directory exists but the helper never writes its
      ready file, which is what a helper macOS refuses to start looks like. */
  const silentHost = FileSystem.layerNoop({
    makeTempDirectoryScoped: () => Effect.succeed("/tmp/t3-helper"),
  });

  const launcherWith = (spawned: Queue.Queue<SpawnedCommand>, appPath: string | null) =>
    loginSessionLauncherLayer.pipe(
      Layer.provide(binaryLayer(appPath)),
      Layer.provide(recordingSpawner(spawned)),
      Layer.provide(silentHost),
      Layer.provide(Path.layer),
      Layer.provide(fakeCrypto),
    );

  it.effect("opens the helper app through Launch Services and waits ten seconds for it", () =>
    Effect.gen(function* () {
      const spawned = yield* Queue.unbounded<SpawnedCommand>();
      const opening = yield* Effect.gen(function* () {
        const launcher = yield* ComputerHelperLauncher;
        return yield* launcher.open;
      }).pipe(
        Effect.scoped,
        Effect.flip,
        Effect.provide(launcherWith(spawned, HELPER_APP)),
        Effect.forkChild,
      );

      const command = yield* Queue.take(spawned);
      expect(command.command).toBe("/usr/bin/open");
      expect(command.args).toEqual([
        "-n",
        "-a",
        HELPER_APP,
        "--args",
        "--socket",
        "/tmp/t3-helper/helper.sock",
        "--token",
        "ab".repeat(16),
        "--ready-file",
        "/tmp/t3-helper/ready.json",
        "--exit-on-disconnect",
      ]);

      yield* TestClock.adjust(Duration.seconds(9));
      expect(opening.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(Duration.seconds(1));
      const failure = yield* Fiber.join(opening);
      expect(failure.reason).toContain("did not report that it was ready");
    }),
  );

  it.effect("refuses a bare executable, which macOS cannot attribute permissions to", () =>
    Effect.gen(function* () {
      const spawned = yield* Queue.unbounded<SpawnedCommand>();
      const failure = yield* Effect.gen(function* () {
        const launcher = yield* ComputerHelperLauncher;
        return yield* launcher.open;
      }).pipe(Effect.scoped, Effect.flip, Effect.provide(launcherWith(spawned, null)));

      expect(failure._tag).toBe("ComputerHelperUnavailable");
      expect(failure.reason).toContain("T3CODE_COMPUTER_HELPER_LAUNCH=child");
      expect(yield* Queue.size(spawned)).toBe(0);
    }),
  );
});
