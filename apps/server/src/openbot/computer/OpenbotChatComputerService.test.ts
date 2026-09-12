import { assert, it } from "@effect/vitest";
import {
  NO_COMPUTER_CAPABILITIES,
  OpenbotChannelId,
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  OpenbotComputerWindowId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OpenbotChannel,
  type OpenbotComputerDisplay,
  type OpenbotComputerDisplayCreateInput,
  type OpenbotComputerLaunchInput,
  type OpenbotComputerPermissionState,
  type OpenbotComputerStatus,
  type OpenbotComputerWindow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";

import { OpenbotChannelStore } from "../OpenbotChannelStore.ts";
import type { OpenbotChatComputerShape } from "./OpenbotChatComputer.ts";
import { make } from "./OpenbotChatComputerService.ts";
import { OpenbotComputerSession, type ComputerInputSource } from "./OpenbotComputerSession.ts";

/**
 * The rules under test are all about ownership: which display a chat means,
 * and what happens to a call aimed anywhere else. The fake host therefore
 * always has a physical main display, so "never targets a physical display" is
 * a claim about behaviour rather than about a host that has nothing else.
 */

const PHYSICAL_MAIN: OpenbotComputerDisplay = {
  id: OpenbotComputerDisplayId.make("physical-main"),
  name: "Built-in Display",
  kind: "physical",
  widthPx: 2560,
  heightPx: 1600,
  scale: 2,
  main: true,
  managed: false,
};

const windowOn = (id: string, displayId: OpenbotComputerDisplay["id"]): OpenbotComputerWindow => ({
  id: OpenbotComputerWindowId.make(id),
  displayId,
  title: id,
  app: "Safari",
  pid: 501,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  focused: false,
  minimized: false,
});

const viewer: ComputerInputSource = {
  kind: "viewer",
  viewerId: "viewer:test",
  sessionId: "session:test",
  label: "Rhys",
};

const chat = (id: string, name: string, parentChannelId: string | null = null): OpenbotChannel => ({
  id: OpenbotChannelId.make(id),
  name,
  avatar: "🤖",
  description: "",
  revision: 0,
  projectId: ProjectId.make(`project:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  parentChannelId: parentChannelId === null ? null : OpenbotChannelId.make(parentChannelId),
  openbotProjectId: null,
  createdAt: "2026-09-08T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:00.000Z",
});

interface FakeHostOptions {
  readonly platform?: "darwin" | "linux";
  readonly accessibility?: OpenbotComputerPermissionState;
  readonly windows?: ReadonlyArray<OpenbotComputerWindow>;
  /** Held open inside `createDisplay`, so a second caller can be observed
      arriving while the first creation is still in flight. */
  readonly gate?: Deferred.Deferred<void>;
  /** Completed the moment `createDisplay` is entered. */
  readonly createStarted?: Deferred.Deferred<void>;
  /** How many `createDisplay` calls fail before the host starts succeeding. */
  readonly failCreates?: number;
  readonly failDestroys?: number;
}

/** What a host with no virtual display driver says. */
const CREATE_FAILURE_DETAIL = "no virtual display driver";

const makeFakeHost = (options: FakeHostOptions = {}) => {
  const displays: Array<OpenbotComputerDisplay> = [PHYSICAL_MAIN];
  const windows = options.windows ?? [];
  const created: Array<OpenbotComputerDisplayCreateInput> = [];
  const destroyed: Array<OpenbotComputerDisplay["id"]> = [];
  const snapshotted: Array<OpenbotComputerDisplay["id"] | undefined> = [];
  const focused: Array<OpenbotComputerWindow["id"]> = [];
  const launched: Array<OpenbotComputerLaunchInput> = [];
  let listedDisplays = 0;
  let nextDisplay = 0;

  const status: OpenbotComputerStatus = {
    host: { label: "test host", platform: options.platform ?? "darwin" },
    session: options.platform === "linux" ? "managed-x11-session" : "signed-in-desktop",
    availability: "ready",
    detail: null,
    permissions: {
      screenCapture: "granted",
      accessibility: options.accessibility ?? "granted",
      detail: null,
    },
    setup: null,
    capabilities: {
      ...NO_COMPUTER_CAPABILITIES,
      windows: true,
      managedDisplays: true,
      launchApp: true,
    },
    displays,
    windows,
    controller: null,
    lastCaptureAt: null,
    lastError: null,
    checkedAt: "2026-09-08T10:00:00.000Z",
  };

  const session: Partial<OpenbotComputerSession["Service"]> = {
    status: Effect.succeed(status),
    controller: Effect.succeed(null),
    listDisplays: Effect.sync(() => {
      listedDisplays += 1;
      return [...displays];
    }),
    listWindows: (displayId) =>
      Effect.sync(() =>
        displayId === undefined
          ? windows
          : windows.filter((window) => window.displayId === displayId),
      ),
    createDisplay: Effect.fn("fake.createDisplay")(function* (input) {
      created.push(input);
      if (options.createStarted !== undefined) {
        yield* Deferred.succeed(options.createStarted, undefined);
      }
      if (options.gate !== undefined) yield* Deferred.await(options.gate);
      if (created.length <= (options.failCreates ?? 0)) {
        return yield* new OpenbotComputerError({
          code: "backend_unavailable",
          message: CREATE_FAILURE_DETAIL,
        });
      }
      nextDisplay += 1;
      const display: OpenbotComputerDisplay = {
        id: OpenbotComputerDisplayId.make(`managed-${nextDisplay}`),
        name: input.name ?? "Managed display",
        kind: "managed-virtual",
        widthPx: input.widthPx,
        heightPx: input.heightPx,
        scale: input.hiDpi === true ? 2 : 1,
        main: false,
        managed: true,
      };
      displays.push(display);
      return display;
    }),
    destroyDisplay: (id) =>
      Effect.gen(function* () {
        destroyed.push(id);
        if (destroyed.length <= (options.failDestroys ?? 0)) {
          return yield* new OpenbotComputerError({
            code: "backend_unavailable",
            message: "Host unavailable",
          });
        }
        const index = displays.findIndex((display) => display.id === id);
        if (index >= 0) displays.splice(index, 1);
      }),
    snapshot: (input) =>
      Effect.sync(() => {
        snapshotted.push(input.displayId);
        return {
          mimeType: "image/jpeg" as const,
          dataBase64: "ZmFrZQ==",
          capturedAt: "2026-09-08T10:00:01.000Z",
          caveat: null,
        };
      }),
    focusWindow: (_source, id) => Effect.sync(() => void focused.push(id)),
    launch: (_source, input) =>
      Effect.sync(() => {
        launched.push(input);
        return { pid: 4321 };
      }),
  };

  return {
    session,
    created,
    destroyed,
    /** How often a caller checked the remembered display against the host. */
    listedDisplays: () => listedDisplays,
    snapshotted,
    focused,
    launched,
    /** The host losing a managed screen, as a helper restart does. */
    forget: (id: OpenbotComputerDisplay["id"]) => {
      const at = displays.findIndex((display) => display.id === id);
      if (at >= 0) displays.splice(at, 1);
    },
  };
};

const withService = <A, E>(
  channels: ReadonlyArray<OpenbotChannel>,
  session: Partial<OpenbotComputerSession["Service"]>,
  use: (service: OpenbotChatComputerShape) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(make, use).pipe(
    Effect.provide(
      Layer.merge(
        Layer.mock(OpenbotComputerSession)(session),
        Layer.mock(OpenbotChannelStore)({
          getById: (channelId) =>
            Effect.succeed(channels.find((channel) => channel.id === channelId)),
          getByThreadId: (threadId) =>
            Effect.succeed(channels.find((channel) => channel.threadId === threadId)),
        }),
      ),
    ),
  );

const solo = chat("channel:solo", "Research bot");

it.effect("provisions a chat's display once and reuses it", () =>
  Effect.gen(function* () {
    const host = makeFakeHost();

    const [first, second] = yield* withService([solo], host.session, (service) =>
      Effect.all([service.ensure(solo.id), service.ensure(solo.id)]),
    );

    assert.deepEqual(host.created, [
      { name: "Research bot", widthPx: 1680, heightPx: 1050, hiDpi: true },
    ]);
    assert.equal(first.state, "ready");
    assert.equal(first.channelName, "Research bot");
    assert.equal(first.display?.kind, "managed-virtual");
    assert.equal(first.display?.main, false);
    assert.equal(second.display?.id, first.display?.id);
  }),
);

it.effect("concurrent ensure calls share one creation", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const createStarted = yield* Deferred.make<void>();
    const host = makeFakeHost({ gate, createStarted });

    // The releaser only opens the gate once a creation is actually in flight,
    // so the second caller reaches the service while the first is still
    // waiting on the host rather than after it has finished.
    const [first, second] = yield* withService([solo], host.session, (service) =>
      Effect.all(
        [
          service.ensure(solo.id),
          service.ensure(solo.id),
          Deferred.await(createStarted).pipe(
            Effect.flatMap(() => Deferred.succeed(gate, undefined)),
          ),
        ],
        { concurrency: 3 },
      ),
    );

    assert.equal(host.created.length, 1);
    assert.equal(first.state, "ready");
    assert.equal(second.display?.id, first.display?.id);
    // Nobody re-listed the host's displays: the second caller waited on the
    // creation in flight instead of finding a finished one.
    assert.equal(host.listedDisplays(), 0);
  }),
);

it.effect("an interrupted creator still settles the entry and its waiting peer", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const createStarted = yield* Deferred.make<void>();
    const host = makeFakeHost({ gate, createStarted });

    const [peerView, afterwards, abandoned] = yield* withService([solo], host.session, (service) =>
      Effect.gen(function* () {
        const creator = yield* service.ensure(solo.id).pipe(Effect.forkChild);
        // The creator now owns the entry and is inside the host's create call.
        yield* Deferred.await(createStarted);
        // Started here, so the peer is parked on that creation rather than
        // racing it.
        const peer = yield* service
          .ensure(solo.id)
          .pipe(Effect.forkChild({ startImmediately: true }));

        // The viewer socket that asked for the screen goes away mid-creation.
        // Signalled rather than awaited: `Fiber.interrupt` would block until
        // the creator finishes, and the creator is still holding the gate.
        yield* Effect.sync(() => creator.interruptUnsafe());
        yield* Deferred.succeed(gate, undefined);

        return [
          yield* Fiber.join(peer),
          yield* service.get(solo.id),
          yield* Fiber.await(creator),
        ] as const;
      }),
    );

    assert.isTrue(Exit.isFailure(abandoned) && Cause.hasInterrupts(abandoned.cause));
    assert.equal(host.created.length, 1);
    assert.equal(peerView.state, "ready");
    assert.equal(peerView.display?.kind, "managed-virtual");
    // The abandoned creation is the chat's display, not an orphan: the map
    // agrees with what the waiter was handed.
    assert.equal(afterwards.state, "ready");
    assert.equal(afterwards.display?.id, peerView.display?.id);
    // Nobody re-listed the host: the peer waited on the creation in flight.
    assert.equal(host.listedDisplays(), 0);
  }),
);

/**
 * How many operations the creator fiber may run before the runtime yields it.
 * Three is the smallest budget that still makes progress: one operation goes
 * on resuming the fiber, one on the next real step, and the third trips the
 * yield check, so the creator advances exactly one step per scheduler turn and
 * the test can look at the service between any two of its steps. A budget of
 * one or two never gets past resuming, and the fiber stalls forever.
 */
const ONE_STEP_PER_TURN = 3;

/** How many scheduler turns the test will spend waiting for something to
    happen. Bounded so a stranded entry fails an assertion instead of hanging
    the run; the fake host answers synchronously, so a healthy service needs
    two orders of magnitude fewer than this. */
const MAX_TURNS = 2000;

it.effect(
  "a creator interrupted before it asks the host still settles the entry and its waiting peer",
  () =>
    Effect.gen(function* () {
      const createStarted = yield* Deferred.make<void>();
      const host = makeFakeHost({ createStarted });

      const [peerView, afterwards, abandoned] = yield* withService(
        [solo],
        host.session,
        (service) =>
          Effect.gen(function* () {
            const creator = yield* service
              .ensure(solo.id)
              .pipe(
                Effect.provideService(Scheduler.MaxOpsBeforeYield, ONE_STEP_PER_TURN),
                Effect.forkChild,
              );

            // Step the creator forward until it has published `provisioning` but
            // has not yet reached the host. That window is the one an interrupt
            // used to fall into: the entry names this fiber as the owner, and
            // nothing has been asked of the host that would make it settle.
            let caught = false;
            for (let turn = 0; turn < MAX_TURNS && !caught; turn += 1) {
              const view = yield* service.get(solo.id);
              const entered = yield* Deferred.isDone(createStarted);
              if (view.state === "provisioning" && host.created.length === 0 && !entered) {
                // The viewer socket that asked for the screen goes away. Signalled
                // rather than awaited, exactly as a closing socket does.
                yield* Effect.sync(() => creator.interruptUnsafe());
                caught = true;
              } else {
                yield* Effect.yieldNow;
              }
            }
            assert.isTrue(
              caught,
              "the creator never published `provisioning` before reaching the host, so the window under test was never entered",
            );

            // Started while the entry still belongs to the interrupted creator, so
            // the peer parks on that creation rather than finding a finished one.
            const peer = yield* service
              .ensure(solo.id)
              .pipe(Effect.forkChild({ startImmediately: true }));

            let settled = peer.pollUnsafe();
            for (let turn = 0; turn < MAX_TURNS && settled === undefined; turn += 1) {
              yield* Effect.yieldNow;
              settled = peer.pollUnsafe();
            }
            assert.isDefined(
              settled,
              "the peer never came back: the interrupted creator left the entry provisioning with nobody to complete it",
            );

            return [
              yield* Fiber.join(peer),
              yield* service.get(solo.id),
              yield* Fiber.await(creator),
            ] as const;
          }),
      );

      assert.isTrue(Exit.isFailure(abandoned) && Cause.hasInterrupts(abandoned.cause));
      // The interrupt was held off until the entry was settled, so the host was
      // asked exactly once and the answer went to the waiter.
      assert.equal(host.created.length, 1);
      assert.equal(peerView.state, "ready");
      assert.equal(peerView.display?.kind, "managed-virtual");
      assert.equal(afterwards.state, "ready");
      assert.equal(afterwards.display?.id, peerView.display?.id);
      // Nobody re-listed the host: the peer waited on the creation in flight.
      assert.equal(host.listedDisplays(), 0);
    }),
);

it.effect("a creation failure frees the entry so the next ensure retries", () =>
  Effect.gen(function* () {
    const host = makeFakeHost({ failCreates: 1 });

    const [refused, retried] = yield* withService([solo], host.session, (service) =>
      Effect.gen(function* () {
        const first = yield* service.ensure(solo.id);
        return [first, yield* service.ensure(solo.id)] as const;
      }),
    );

    assert.equal(refused.state, "unavailable");
    assert.equal(refused.display, null);
    assert.equal(refused.detail, CREATE_FAILURE_DETAIL);
    assert.equal(retried.state, "ready");
    assert.equal(retried.display?.kind, "managed-virtual");
    assert.equal(host.created.length, 2);
  }),
);

it.effect("a child chat inherits its parent's computer", () =>
  Effect.gen(function* () {
    const parent = chat("channel:parent", "Project bot");
    const child = chat("channel:child", "Side quest", parent.id);
    const host = makeFakeHost();

    const [fromChild, fromParent] = yield* withService([parent, child], host.session, (service) =>
      Effect.all([service.ensure(child.id), service.ensure(parent.id)]),
    );

    assert.equal(host.created.length, 1);
    assert.equal(fromChild.channelId, parent.id);
    assert.equal(fromChild.channelName, "Project bot");
    assert.equal(fromParent.display?.id, fromChild.display?.id);
  }),
);

it.effect("a two-level or cyclic parent chain is rejected, not followed", () =>
  Effect.gen(function* () {
    const root = chat("channel:root", "Root");
    const middle = chat("channel:middle", "Middle", root.id);
    const leaf = chat("channel:leaf", "Leaf", middle.id);
    const looped = chat("channel:looped", "Looped", "channel:looped");
    const host = makeFakeHost();

    const [deep, cyclic] = yield* withService(
      [root, middle, leaf, looped],
      host.session,
      (service) =>
        Effect.all([
          service.ensure(leaf.id).pipe(Effect.flip),
          service.ensure(looped.id).pipe(Effect.flip),
        ]),
    );

    assert.equal(deep.code, "invalid_input");
    assert.include(deep.message, "chat nesting is one level");
    assert.equal(cyclic.code, "invalid_input");
    assert.include(cyclic.message, "chat nesting is one level");
    // A broken chain must never fall back to a display of its own or anyone
    // else's.
    assert.deepEqual(host.created, []);
  }),
);

it.effect("snapshot of a chat never targets a physical display", () =>
  Effect.gen(function* () {
    const host = makeFakeHost();

    const managed = yield* withService([solo], host.session, (service) =>
      service
        .snapshot(solo.id, 800)
        .pipe(Effect.flatMap(() => service.get(solo.id).pipe(Effect.map((view) => view.display)))),
    );

    assert.equal(host.snapshotted.length, 1);
    assert.equal(host.snapshotted[0], managed?.id);
    assert.notEqual(host.snapshotted[0], PHYSICAL_MAIN.id);
  }),
);

it.effect("focusing a window on another display is refused", () =>
  Effect.gen(function* () {
    const stranger = windowOn("window:on-main", PHYSICAL_MAIN.id);
    const host = makeFakeHost({ windows: [stranger] });

    const failure = yield* withService([solo], host.session, (service) =>
      service.focusWindow(viewer, solo.id, stranger.id).pipe(Effect.flip),
    );

    assert.equal(failure.code, "window_not_found");
    assert.deepEqual(host.focused, []);
  }),
);

it.effect("launch is refused without Accessibility and nothing is launched", () =>
  Effect.gen(function* () {
    const host = makeFakeHost({ platform: "darwin", accessibility: "denied" });

    const failure = yield* withService([solo], host.session, (service) =>
      service.launch(viewer, solo.id, { app: "Safari" }).pipe(Effect.flip),
    );

    assert.equal(failure.code, "permission_denied");
    assert.include(failure.message, "T3 Computer Helper");
    assert.deepEqual(host.launched, []);
  }),
);

it.effect("recreates the display when the host lost it", () =>
  Effect.gen(function* () {
    const host = makeFakeHost();

    const [before, after] = yield* withService([solo], host.session, (service) =>
      Effect.gen(function* () {
        const first = yield* service.ensure(solo.id);
        if (first.display !== null) host.forget(first.display.id);
        return [first, yield* service.ensure(solo.id)] as const;
      }),
    );

    assert.equal(host.created.length, 2);
    assert.equal(after.state, "ready");
    assert.notEqual(after.display?.id, before.display?.id);
  }),
);

it.effect("get does not provision", () =>
  Effect.gen(function* () {
    const host = makeFakeHost();

    const view = yield* withService([solo], host.session, (service) => service.get(solo.id));

    assert.equal(view.state, "idle");
    assert.equal(view.display, null);
    assert.deepEqual(view.windows, []);
    assert.deepEqual(host.created, []);
  }),
);

it.effect("releasing a child leaves its parent's managed display alone", () =>
  Effect.gen(function* () {
    const child = chat("child", "Child", solo.id);
    const host = makeFakeHost();
    yield* withService([solo, child], host.session, (service) =>
      Effect.gen(function* () {
        const before = yield* service.ensure(child.id);
        yield* service.release(child.id);
        const after = yield* service.ensure(solo.id);
        assert.equal(after.display?.id, before.display?.id);
        assert.deepEqual(host.destroyed, []);
        yield* service.release(solo.id);
        assert.deepEqual(host.destroyed, [before.display?.id]);
        assert.equal((yield* service.get(solo.id)).state, "unavailable");
        assert.equal(Exit.isFailure(yield* Effect.exit(service.ensure(solo.id))), true);
      }),
    );
  }),
);

it.effect("release waits for in-flight creation and never recreates the display", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const createStarted = yield* Deferred.make<void>();
    const host = makeFakeHost({ gate, createStarted });
    yield* withService([solo], host.session, (service) =>
      Effect.gen(function* () {
        const creating = yield* service.ensure(solo.id).pipe(Effect.forkChild);
        yield* Deferred.await(createStarted);
        const releasing = yield* service.release(solo.id).pipe(Effect.forkChild);
        yield* Deferred.succeed(gate, undefined);
        const before = yield* Fiber.join(creating);
        yield* Fiber.join(releasing);
        assert.deepEqual(host.destroyed, [before.display?.id]);
        yield* service.release(solo.id);
        assert.equal(host.destroyed.length, 1);
        assert.equal(Exit.isFailure(yield* Effect.exit(service.ensure(solo.id))), true);
        assert.equal(host.created.length, 1);
      }),
    );
  }),
);

it.effect("release retries failed host cleanup without losing display ownership", () =>
  Effect.gen(function* () {
    const host = makeFakeHost({ failDestroys: 1 });
    yield* withService([solo], host.session, (service) =>
      Effect.gen(function* () {
        const before = yield* service.ensure(solo.id);
        assert.equal(Exit.isFailure(yield* Effect.exit(service.release(solo.id))), true);
        assert.equal(Exit.isFailure(yield* Effect.exit(service.ensure(solo.id))), true);
        yield* service.release(solo.id);
        assert.deepEqual(host.destroyed, [before.display?.id, before.display?.id]);
        assert.equal(host.created.length, 1);
      }),
    );
  }),
);
