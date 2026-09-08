import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  NO_COMPUTER_CAPABILITIES,
  type OpenbotComputerCapabilities,
  type OpenbotComputerDisplay,
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  type OpenbotComputerInputEvent,
  type OpenbotComputerPermissions,
  type OpenbotComputerWindow,
  type OpenbotComputerWindowId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import {
  ComputerBackend,
  type CaptureProfile,
  type ComputerBackendDescription,
  type ComputerBackendShape,
  type ComputerFrame,
} from "./ComputerBackend.ts";
import { make as makeSession } from "./OpenbotComputerSessionService.ts";

/**
 * A `ComputerBackend` that answers from memory, so the session's viewer, lease,
 * queue, and capture rules can be driven exactly (and without sleeps) from a
 * test. Shared with the stream route test, which needs the same fake host.
 */

export const displayId = (value: string) => OpenbotComputerDisplayId.make(value);

export const MAIN_DISPLAY: OpenbotComputerDisplay = {
  id: displayId("main"),
  name: "Built-in Display",
  kind: "physical",
  widthPx: 2560,
  heightPx: 1600,
  scale: 2,
  main: true,
  managed: false,
};

export const SIDE_DISPLAY: OpenbotComputerDisplay = {
  id: displayId("side"),
  name: "Side Display",
  kind: "physical",
  widthPx: 1920,
  heightPx: 1080,
  scale: 1,
  main: false,
  managed: false,
};

export const ALL_CAPABILITIES: OpenbotComputerCapabilities = {
  stream: true,
  input: true,
  windows: true,
  focusWindow: true,
  managedDisplays: true,
  launchApp: true,
};

const GRANTED: OpenbotComputerPermissions = {
  screenCapture: "granted",
  accessibility: "granted",
  detail: null,
};

export const frame = (id: OpenbotComputerDisplayId, capturedAtMs: number): ComputerFrame => ({
  displayId: id,
  jpeg: new Uint8Array([0xff, 0xd8, capturedAtMs & 0xff, 0xff, 0xd9]),
  widthPx: 320,
  heightPx: 200,
  capturedAtMs,
});

export interface DeliveredBatch {
  readonly displayId: OpenbotComputerDisplayId;
  readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
}

export interface StartedCapture {
  readonly displayId: OpenbotComputerDisplayId;
  readonly profile: CaptureProfile;
}

export interface FakeComputerHost {
  readonly shape: ComputerBackendShape;
  /** Every batch the backend was handed, in delivery order. */
  readonly delivered: Effect.Effect<ReadonlyArray<DeliveredBatch>>;
  /** Every window the backend was asked to raise, in order. */
  readonly focused: Effect.Effect<ReadonlyArray<OpenbotComputerWindowId>>;
  /** Every app the backend was asked to launch, in order. */
  readonly launched: Effect.Effect<ReadonlyArray<string>>;
  /** Every capture that was started, in order, including restarts. */
  readonly started: Effect.Effect<ReadonlyArray<StartedCapture>>;
  /** Displays whose capture scope has been closed. */
  readonly stopped: Effect.Effect<ReadonlyArray<OpenbotComputerDisplayId>>;
  /** Pushes one frame into the running capture of a display. */
  readonly emitFrame: (frame: ComputerFrame) => Effect.Effect<void>;
  /** Ends the running capture normally, as a display disappearing does. */
  readonly endCapture: (id: OpenbotComputerDisplayId) => Effect.Effect<void>;
  /** Fails the running capture. */
  readonly failCapture: (
    id: OpenbotComputerDisplayId,
    error: OpenbotComputerError,
  ) => Effect.Effect<void>;
  /** Emits a backend change nudge. */
  readonly announceChange: Effect.Effect<void>;
  readonly setDisplays: (displays: ReadonlyArray<OpenbotComputerDisplay>) => Effect.Effect<void>;
  readonly setPermissions: (permissions: OpenbotComputerPermissions) => Effect.Effect<void>;
}

export interface FakeHostOptions {
  readonly platform?: "darwin" | "linux" | "unsupported";
  readonly displays?: ReadonlyArray<OpenbotComputerDisplay>;
  readonly windows?: ReadonlyArray<OpenbotComputerWindow>;
  readonly permissions?: OpenbotComputerPermissions;
  readonly capabilities?: OpenbotComputerCapabilities;
  readonly unavailableReason?: string | null;
  /** Held before each input batch returns, so ordering is observable. */
  readonly onInput?: (batch: DeliveredBatch) => Effect.Effect<void>;
  /** Fails `capture` for this display instead of starting a stream. */
  readonly captureFailure?: OpenbotComputerError;
  readonly screenshot?: (
    id: OpenbotComputerDisplayId,
  ) => Effect.Effect<ComputerFrame, OpenbotComputerError>;
}

export const makeFakeHost = (options: FakeHostOptions = {}) =>
  Effect.gen(function* () {
    const displays = yield* Ref.make<ReadonlyArray<OpenbotComputerDisplay>>(
      options.displays ?? [MAIN_DISPLAY, SIDE_DISPLAY],
    );
    const permissions = yield* Ref.make(options.permissions ?? GRANTED);
    const delivered = yield* Ref.make<ReadonlyArray<DeliveredBatch>>([]);
    const started = yield* Ref.make<ReadonlyArray<StartedCapture>>([]);
    const stopped = yield* Ref.make<ReadonlyArray<OpenbotComputerDisplayId>>([]);
    const focused = yield* Ref.make<ReadonlyArray<OpenbotComputerWindowId>>([]);
    const launched = yield* Ref.make<ReadonlyArray<string>>([]);
    const running = yield* Ref.make<
      ReadonlyMap<string, Queue.Queue<ComputerFrame, OpenbotComputerError | Cause.Done>>
    >(new Map());
    const changes = yield* PubSub.unbounded<void>();

    const description: ComputerBackendDescription = {
      session: options.platform === "linux" ? "shared-x11-desktop" : "signed-in-desktop",
      permissions: options.permissions ?? GRANTED,
      setup: null,
      capabilities:
        options.capabilities ??
        (options.platform === "unsupported" ? NO_COMPUTER_CAPABILITIES : ALL_CAPABILITIES),
      unavailableReason: options.unavailableReason ?? null,
    };

    const queueFor = (id: OpenbotComputerDisplayId) =>
      Ref.get(running).pipe(Effect.map((map) => map.get(id) ?? null));

    const shape: ComputerBackendShape = {
      platform: options.platform ?? "darwin",
      describe: Ref.get(permissions).pipe(
        Effect.map((current) => ({ ...description, permissions: current })),
      ),
      listDisplays: Ref.get(displays),
      listWindows: Effect.succeed(options.windows ?? []),
      focusWindow: (id) => Ref.update(focused, (all) => [...all, id]),
      screenshot: (id) => options.screenshot?.(id) ?? Effect.succeed(frame(id, 1_000)),
      capture: (id, profile) =>
        Effect.gen(function* () {
          if (options.captureFailure !== undefined) return yield* options.captureFailure;
          yield* Ref.update(started, (all) => [...all, { displayId: id, profile }]);
          const queue = yield* Queue.make<ComputerFrame, OpenbotComputerError | Cause.Done>();
          yield* Ref.update(running, (map) => new Map(map).set(id, queue));
          yield* Effect.addFinalizer(() =>
            Ref.update(running, (map) => {
              const next = new Map(map);
              next.delete(id);
              return next;
            }).pipe(Effect.andThen(Ref.update(stopped, (all) => [...all, id]))),
          );
          return Stream.fromQueue(queue);
        }),
      input: (id, events) =>
        Effect.gen(function* () {
          const batch = { displayId: id, events };
          yield* Ref.update(delivered, (all) => [...all, batch]);
          if (options.onInput !== undefined) yield* options.onInput(batch);
          return { delivered: events.length, rejected: [] };
        }),
      createDisplay: (input) =>
        Effect.gen(function* () {
          const created: OpenbotComputerDisplay = {
            id: displayId(`managed-${input.widthPx}x${input.heightPx}`),
            name: input.name ?? "Managed display",
            kind: "managed-virtual",
            widthPx: input.widthPx,
            heightPx: input.heightPx,
            scale: 1,
            main: false,
            managed: true,
          };
          yield* Ref.update(displays, (all) => [...all, created]);
          return created;
        }),
      destroyDisplay: (id) =>
        Ref.update(displays, (all) => all.filter((display) => display.id !== id)),
      launch: (input) =>
        Ref.update(launched, (all) => [...all, input.app]).pipe(Effect.as({ pid: 4321 })),
      changes: Stream.fromPubSub(changes),
    };

    return {
      shape,
      delivered: Ref.get(delivered),
      focused: Ref.get(focused),
      launched: Ref.get(launched),
      started: Ref.get(started),
      stopped: Ref.get(stopped),
      emitFrame: (value) =>
        queueFor(value.displayId).pipe(
          Effect.flatMap((queue) => (queue === null ? Effect.void : Queue.offer(queue, value))),
          Effect.asVoid,
        ),
      endCapture: (id) =>
        queueFor(id).pipe(
          Effect.flatMap((queue) => (queue === null ? Effect.void : Queue.end(queue))),
          Effect.asVoid,
        ),
      failCapture: (id, error) =>
        queueFor(id).pipe(
          Effect.flatMap((queue) => (queue === null ? Effect.void : Queue.fail(queue, error))),
          Effect.asVoid,
        ),
      announceChange: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
      setDisplays: (value) => Ref.set(displays, value),
      setPermissions: (value) => Ref.set(permissions, value),
    } satisfies FakeComputerHost;
  });

const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("env-test"),
  label: "Test Mac Studio",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.0",
  capabilities: { repositoryIdentity: false },
};

export const testEnvironmentLayer = (
  platform: ExecutionEnvironmentDescriptor["platform"]["os"] = "darwin",
) =>
  Layer.succeed(
    ServerEnvironment,
    ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(descriptor.environmentId),
      getDescriptor: Effect.succeed({
        ...descriptor,
        platform: { ...descriptor.platform, os: platform },
      }),
    }),
  );

/** Builds a session over a fake host and hands back both, scoped to the caller. */
export const makeTestSession = (options: FakeHostOptions = {}) =>
  Effect.gen(function* () {
    const host = yield* makeFakeHost(options);
    const session = yield* makeSession.pipe(
      Effect.provideService(ComputerBackend, ComputerBackend.of(host.shape)),
      Effect.provide(testEnvironmentLayer(options.platform === "linux" ? "linux" : "darwin")),
    );
    return { host, session };
  });
