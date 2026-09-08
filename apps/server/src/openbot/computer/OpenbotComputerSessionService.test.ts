import { expect, it } from "@effect/vitest";
import {
  OpenbotComputerError,
  OpenbotComputerWindowId,
  type OpenbotComputerInputEvent,
  type OpenbotComputerStreamServerMessage,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import type { ComputerFrame } from "./ComputerBackend.ts";
import {
  computerAvailability,
  captureFrameSize,
  ACCESSIBILITY_DENIED_DETAIL,
  INPUT_CANCELLED_REASON,
  NOT_CONTROLLING_REASON,
  NOT_TRIED_DETAIL,
  PERMISSION_CAVEAT,
} from "./OpenbotComputerSessionService.ts";
import type { ComputerViewer } from "./OpenbotComputerSession.ts";
import {
  ALL_CAPABILITIES,
  MAIN_DISPLAY,
  SIDE_DISPLAY,
  frame,
  makeTestSession,
  type FakeHostOptions,
} from "./OpenbotComputerSessionService.testkit.ts";

const PROFILE = { maxWidthPx: 1280, fps: 10, quality: 0.7 } as const;
const BIG_PROFILE = { maxWidthPx: 1920, fps: 24, quality: 0.9 } as const;

const isFrame = (
  message: OpenbotComputerStreamServerMessage | ComputerFrame,
): message is ComputerFrame => "jpeg" in message;

const serverMessages = (
  messages: ReadonlyArray<OpenbotComputerStreamServerMessage | ComputerFrame>,
): ReadonlyArray<OpenbotComputerStreamServerMessage> =>
  messages.filter((m): m is OpenbotComputerStreamServerMessage => !isFrame(m));

/** Takes exactly `count` items off a viewer's stream. */
const take = (viewer: ComputerViewer, count: number) =>
  viewer.messages.pipe(Stream.take(count), Stream.runCollect);

const session = (options?: FakeHostOptions) => makeTestSession(options);

const clickAt = (x: number, y: number): OpenbotComputerInputEvent => ({
  type: "click",
  button: "left",
  count: 1,
  point: { x, y },
});

describe("OpenbotComputerSessionService", () => {
  it.effect("greets the first viewer and starts one capture for its display", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);

        const [hello, capturing] = serverMessages(yield* take(viewer, 2));
        expect(hello).toEqual({
          type: "hello",
          viewerId: viewer.viewerId,
          display: MAIN_DISPLAY,
          frameWidthPx: 1280,
          frameHeightPx: 800,
          fps: 10,
          encoding: "image/jpeg",
          controller: null,
          controlling: false,
        });
        expect(capturing).toEqual({ type: "status", state: "capturing", message: null });
        expect(yield* host.started).toEqual([{ displayId: MAIN_DISPLAY.id, profile: PROFILE }]);
      }),
    ),
  );

  it.effect("runs one capture at the widest profile any viewer asked for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const modest = yield* computer.attachViewer({
          label: "Phone",
          sessionId: "session-phone",
          canControl: false,
        });
        yield* modest.open(MAIN_DISPLAY.id, PROFILE);
        const greedy = yield* computer.attachViewer({
          label: "Desktop",
          sessionId: "session-desktop",
          canControl: true,
        });
        yield* greedy.open(MAIN_DISPLAY.id, BIG_PROFILE);

        expect(yield* host.started).toEqual([
          { displayId: MAIN_DISPLAY.id, profile: PROFILE },
          { displayId: MAIN_DISPLAY.id, profile: BIG_PROFILE },
        ]);
        // The narrow viewer is told its picture changed shape rather than
        // silently receiving frames of another size.
        expect(serverMessages(yield* take(modest, 4)).at(-1)).toEqual({
          type: "status",
          state: "capturing",
          message: null,
        });
      }),
    ),
  );

  it.effect("stops capturing a display once its last viewer goes away", () =>
    Effect.gen(function* () {
      const { host, session: computer } = yield* session();
      const scope = yield* Scope.make();
      const viewer = yield* computer
        .attachViewer({ label: "Rhys", sessionId: "session-rhys", canControl: true })
        .pipe(Scope.provide(scope));
      yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
      expect(yield* host.stopped).toEqual([]);

      yield* Scope.close(scope, yield* Effect.exit(Effect.void));
      expect(yield* host.stopped).toEqual([MAIN_DISPLAY.id]);
    }).pipe(Effect.scoped),
  );

  it.effect("tells the viewers of a vanished display, and frees the lease it held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        yield* viewer.takeControl;
        expect(yield* computer.controller).not.toBeNull();

        yield* host.endCapture(MAIN_DISPLAY.id);
        // hello, capturing, controller, then display-gone and the lease loss.
        const messages = serverMessages(yield* take(viewer, 5));
        expect(messages.some((m) => m.type === "status" && m.state === "display-gone")).toBe(true);
        expect(yield* computer.controller).toBeNull();
        expect((yield* computer.status).controller).toBeNull();
      }),
    ),
  );

  it.effect("keeps one controller: a second viewer is told who has it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session();
        const first = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* first.open(MAIN_DISPLAY.id, PROFILE);
        const second = yield* computer.attachViewer({
          label: "Theo",
          sessionId: "session-theo",
          canControl: true,
        });
        yield* second.open(MAIN_DISPLAY.id, PROFILE);

        yield* first.takeControl;
        const refused = yield* Effect.flip(second.takeControl);
        expect(refused.code).toBe("not_controlling");
        expect(refused.message).toContain("Another controller (Rhys)");

        yield* first.releaseControl;
        yield* second.takeControl;
        expect(yield* computer.controller).toMatchObject({ kind: "viewer", label: "Theo" });
      }),
    ),
  );

  it.effect(
    "closing a view-only connection from the same session leaves the controller in control",
    () =>
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const controlling = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* controlling.open(MAIN_DISPLAY.id, PROFILE);
        yield* controlling.takeControl;

        // The same person's second window, watching the same desktop.
        const watchingScope = yield* Scope.make();
        const watching = yield* computer
          .attachViewer({ label: "Rhys (phone)", sessionId: "session-rhys", canControl: false })
          .pipe(Scope.provide(watchingScope));
        yield* watching.open(MAIN_DISPLAY.id, PROFILE);
        yield* Scope.close(watchingScope, Exit.void);

        expect(yield* controlling.input([clickAt(7, 7)])).toEqual({ delivered: 1, rejected: [] });
        expect((yield* host.delivered).at(-1)).toEqual({
          displayId: MAIN_DISPLAY.id,
          events: [clickAt(7, 7)],
        });
        expect(yield* computer.controller).toMatchObject({ kind: "viewer", label: "Rhys" });
      }).pipe(Effect.scoped),
  );

  it.effect("a second connection of the same session can stop control explicitly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const controlling = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* controlling.open(MAIN_DISPLAY.id, PROFILE);
        yield* controlling.takeControl;
        yield* controlling.input([{ type: "key", key: "ShiftLeft", action: "down" }]);
        const other = yield* computer.attachViewer({
          label: "Rhys (phone)",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* other.open(MAIN_DISPLAY.id, PROFILE);

        yield* other.releaseControl;

        expect(yield* computer.controller).toBeNull();
        expect((yield* host.delivered).at(-1)).toEqual({
          displayId: MAIN_DISPLAY.id,
          events: [{ type: "key", key: "ShiftLeft", action: "up" }],
        });
      }),
    ),
  );

  it.effect("closing the controlling connection frees the lease", () =>
    Effect.gen(function* () {
      const { session: computer } = yield* session();
      const scope = yield* Scope.make();
      const controlling = yield* computer
        .attachViewer({ label: "Rhys", sessionId: "session-rhys", canControl: true })
        .pipe(Scope.provide(scope));
      yield* controlling.open(MAIN_DISPLAY.id, PROFILE);
      yield* controlling.takeControl;
      const watching = yield* computer.attachViewer({
        label: "Rhys (phone)",
        sessionId: "session-rhys",
        canControl: true,
      });
      yield* watching.open(MAIN_DISPLAY.id, PROFILE);

      yield* Scope.close(scope, Exit.void);
      expect(yield* computer.controller).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("hands control to whichever connection of a session took it last", () =>
    Effect.gen(function* () {
      const { session: computer } = yield* session();
      const scope = yield* Scope.make();
      const first = yield* computer
        .attachViewer({ label: "Rhys", sessionId: "session-rhys", canControl: true })
        .pipe(Scope.provide(scope));
      yield* first.open(MAIN_DISPLAY.id, PROFILE);
      yield* first.takeControl;
      const second = yield* computer.attachViewer({
        label: "Rhys (phone)",
        sessionId: "session-rhys",
        canControl: true,
      });
      yield* second.open(MAIN_DISPLAY.id, PROFILE);
      yield* second.takeControl;

      // The connection that took it last is the one whose closing ends it.
      yield* Scope.close(scope, Exit.void);
      expect(yield* computer.controller).toMatchObject({
        kind: "viewer",
        label: "Rhys (phone)",
      });
      yield* second.releaseControl;
      expect(yield* computer.controller).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses control to a connection that may only watch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Read-only",
          sessionId: "session-read-only",
          canControl: false,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        const refused = yield* Effect.flip(viewer.takeControl);
        expect(refused.code).toBe("not_controlling");
        expect(refused.message).toContain("orchestration:operate");
        expect(yield* computer.controller).toBeNull();
      }),
    ),
  );

  it.effect("rejects every event from a viewer without the lease, without touching the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);

        const result = yield* viewer.input([clickAt(1, 1), clickAt(2, 2)]);
        expect(result).toEqual({
          delivered: 0,
          rejected: [
            { index: 0, reason: NOT_CONTROLLING_REASON },
            { index: 1, reason: NOT_CONTROLLING_REASON },
          ],
        });
        expect(yield* host.delivered).toEqual([]);
      }),
    ),
  );

  it.effect("coalesces consecutive moves before the batch reaches the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        yield* viewer.takeControl;

        yield* viewer.input([
          { type: "move", point: { x: 1, y: 1 } },
          { type: "move", point: { x: 2, y: 2 } },
          { type: "move", point: { x: 3, y: 3 } },
          clickAt(3, 3),
        ]);
        const [batch] = yield* host.delivered;
        expect(batch?.events).toEqual([{ type: "move", point: { x: 3, y: 3 } }, clickAt(3, 3)]);
      }),
    ),
  );

  it.effect("puts back whatever a disconnecting controller was holding", () =>
    Effect.gen(function* () {
      const { host, session: computer } = yield* session();
      const scope = yield* Scope.make();
      const viewer = yield* computer
        .attachViewer({ label: "Rhys", sessionId: "session-rhys", canControl: true })
        .pipe(Scope.provide(scope));
      yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
      yield* viewer.takeControl;
      yield* viewer.input([
        { type: "button", button: "left", action: "down", point: { x: 40, y: 40 } },
        { type: "key", key: "ShiftLeft", action: "down" },
      ]);

      yield* Scope.close(scope, yield* Effect.exit(Effect.void));
      const batches = yield* host.delivered;
      expect(batches.at(-1)?.events).toEqual([
        { type: "key", key: "ShiftLeft", action: "up" },
        { type: "button", button: "left", action: "up", point: { x: 40, y: 40 } },
      ]);
      expect(yield* computer.controller).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("lends the lease to an agent batch and takes it straight back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const result = yield* computer.agentInput(
          { kind: "agent", threadId: "thread-1", label: "Codex" },
          MAIN_DISPLAY.id,
          [clickAt(10, 10)],
        );
        expect(result.delivered).toBe(1);
        expect(yield* host.delivered).toHaveLength(1);
        expect(yield* computer.controller).toBeNull();
      }),
    ),
  );

  it.effect("shows the agent as controller for as long as its batch runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const { session: computer } = yield* session({
          onInput: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held))),
        });
        const running = yield* Effect.forkChild(
          computer.agentInput({ kind: "agent", threadId: "t", label: "Codex" }, MAIN_DISPLAY.id, [
            clickAt(1, 1),
          ]),
        );
        yield* Deferred.await(entered);
        expect(yield* computer.controller).toMatchObject({ kind: "agent", label: "Codex" });

        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(running);
        expect(yield* computer.controller).toBeNull();
      }),
    ),
  );

  it.effect("refuses agent input while a human holds the lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        yield* viewer.takeControl;

        const refused = yield* Effect.flip(
          computer.agentInput({ kind: "agent", threadId: "t", label: "Codex" }, MAIN_DISPLAY.id, [
            clickAt(1, 1),
          ]),
        );
        expect(refused.code).toBe("not_controlling");
        expect(yield* host.delivered).toEqual([]);
        expect(yield* computer.controller).toMatchObject({ kind: "viewer", label: "Rhys" });
      }),
    ),
  );

  it.effect("delivers batches for one display whole and in the order they arrived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const firstEntered = yield* Deferred.make<void>();
        const { host, session: computer } = yield* session({
          onInput: (batch) =>
            batch.events[0]?.type === "move"
              ? Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
              : Effect.void,
        });
        const agent = { kind: "agent", threadId: "t", label: "Codex" } as const;

        const slow = yield* Effect.forkChild(
          computer.agentInput(agent, MAIN_DISPLAY.id, [{ type: "move", point: { x: 1, y: 1 } }]),
        );
        yield* Deferred.await(firstEntered);
        const queued = yield* Effect.forkChild(
          computer.agentInput(agent, MAIN_DISPLAY.id, [clickAt(9, 9)]),
        );
        // The second batch is still waiting on the display's lock.
        expect(yield* host.delivered).toHaveLength(1);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(slow);
        yield* Fiber.join(queued);
        const batches = yield* host.delivered;
        expect(batches.map((batch) => batch.events[0]?.type)).toEqual(["move", "click"]);
      }),
    ),
  );

  it.effect("drops frames rather than queue them for a viewer that is not reading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Slow",
          sessionId: "session-slow",
          canControl: false,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        // Drain the control messages so only frames are left on the stream.
        yield* take(viewer, 2);

        for (const at of [1, 2, 3, 4, 5]) {
          yield* host.emitFrame(frame(MAIN_DISPLAY.id, at));
        }
        const seen = yield* take(viewer, 2);
        // Two slots: the viewer sees the newest frames, not the oldest.
        expect(seen.filter(isFrame).map((f) => f.capturedAtMs)).toEqual([4, 5]);
      }),
    ),
  );

  it.effect("only claims ready after a frame has actually arrived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const before = yield* computer.status;
        expect(before.availability).toBe("unknown");
        expect(before.detail).toBe(NOT_TRIED_DETAIL);
        expect(before.capabilities).toEqual(ALL_CAPABILITIES);

        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: false,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        yield* host.emitFrame(frame(MAIN_DISPLAY.id, 5_000));
        yield* take(viewer, 3);

        const after = yield* computer.status;
        expect(after.availability).toBe("ready");
        expect(after.lastCaptureAt).not.toBeNull();
      }),
    ),
  );

  it.effect("caveats a snapshot taken without a confirmed capture grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session({
          permissions: { screenCapture: "denied", accessibility: "granted", detail: null },
        });
        const snapshot = yield* computer.snapshot({});
        expect(snapshot.displayId).toBe(MAIN_DISPLAY.id);
        expect(snapshot.caveat).toBe(PERMISSION_CAVEAT);
        expect(snapshot.dataBase64.length).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("takes a clean snapshot of a named display and records the evidence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session();
        const snapshot = yield* computer.snapshot({ displayId: SIDE_DISPLAY.id });
        expect(snapshot.caveat).toBeNull();
        expect(snapshot.displayId).toBe(SIDE_DISPLAY.id);
        expect((yield* computer.status).lastCaptureAt).toBe(snapshot.capturedAt);
      }),
    ),
  );

  it.effect("says which display is missing rather than capturing the wrong one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session();
        const failure = yield* Effect.flip(
          computer
            .snapshot({ displayId: SIDE_DISPLAY.id })
            .pipe(
              Effect.andThen(computer.snapshot({ displayId: MAIN_DISPLAY.id })),
              Effect.andThen(computer.snapshot({ displayId: "ghost" as typeof MAIN_DISPLAY.id })),
            ),
        );
        expect(failure.code).toBe("display_not_found");
      }),
    ),
  );

  it.effect("records a failed capture as the reason the host is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session({
          screenshot: () =>
            Effect.fail(
              new OpenbotComputerError({ code: "capture_failed", message: "the screen is asleep" }),
            ),
        });
        yield* Effect.flip(computer.snapshot({}));
        const status = yield* computer.status;
        expect(status.availability).toBe("unavailable");
        expect(status.detail).toContain("the screen is asleep");
        expect(status.lastError).toBe("the screen is asleep");
      }),
    ),
  );

  it.effect("republishes the status once per burst of host changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const changes = yield* Effect.forkChild(
          computer.statusChanges.pipe(Stream.take(2), Stream.runCollect),
        );
        yield* TestClock.adjust("10 millis");
        yield* host.setDisplays([MAIN_DISPLAY]);
        yield* host.announceChange;
        yield* host.announceChange;
        yield* host.announceChange;
        yield* TestClock.adjust("200 millis");

        const [first, second] = yield* Fiber.join(changes);
        expect(first?.displays).toHaveLength(2);
        expect(second?.displays).toHaveLength(1);
      }),
    ),
  );

  it.effect("tells the viewers of a destroyed managed display that it is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const created = yield* computer.createDisplay({ widthPx: 1280, heightPx: 800 });
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* viewer.open(created.id, { maxWidthPx: 1280, fps: 5 });
        yield* take(viewer, 2);

        yield* computer.destroyDisplay(created.id);
        expect(serverMessages(yield* take(viewer, 1))).toEqual([
          { type: "status", state: "display-gone", message: "This display was destroyed." },
        ]);
        expect(yield* host.stopped).toEqual([created.id]);
      }),
    ),
  );

  it.effect("gives an RPC client the same lease rule as a stream viewer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const client = {
          kind: "viewer",
          viewerId: "rpc:session-1",
          sessionId: "session-1",
          label: "web",
        } as const;
        const events = [clickAt(3, 3)];

        const refused = yield* computer.viewerInput(client, MAIN_DISPLAY.id, events);
        expect(refused.rejected).toEqual([{ index: 0, reason: NOT_CONTROLLING_REASON }]);
        expect(yield* host.delivered).toEqual([]);

        const status = yield* computer.control(client, "take");
        expect(status.controller).toMatchObject({ kind: "viewer", label: "web" });
        const delivered = yield* computer.viewerInput(client, MAIN_DISPLAY.id, events);
        expect(delivered).toEqual({ delivered: 1, rejected: [] });

        const released = yield* computer.control(client, "release");
        expect(released.controller).toBeNull();
      }),
    ),
  );

  it.effect("refuses to open a display this host does not have", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        const failure = yield* Effect.flip(viewer.open("ghost" as typeof MAIN_DISPLAY.id, PROFILE));
        expect(failure.code).toBe("display_not_found");
      }),
    ),
  );

  it.effect("cannot let a batch that was cut short land after the control it was sent under", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      const { host, session: computer } = yield* session({
        onInput: (batch) =>
          batch.events[0]?.type === "button"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
            : Effect.void,
      });
      const scope = yield* Scope.make();
      const viewer = yield* computer
        .attachViewer({ label: "Rhys", sessionId: "session-rhys", canControl: true })
        .pipe(Scope.provide(scope));
      yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
      yield* viewer.takeControl;
      const sending = yield* Effect.forkChild(
        viewer.input([{ type: "button", button: "left", action: "down", point: { x: 4, y: 4 } }]),
      );
      yield* Deferred.await(entered);

      // The socket goes away with the press still inside the backend.
      yield* Scope.close(scope, Exit.void);
      expect(yield* Fiber.join(sending)).toEqual({
        delivered: 0,
        rejected: [{ index: 0, reason: INPUT_CANCELLED_REASON }],
      });

      // The cleanup follows the delivery it interrupted rather than racing it,
      // and asks for release-all because half a batch cannot be named.
      const batches = yield* host.delivered;
      expect(batches).toHaveLength(2);
      expect(batches[1]).toEqual({ displayId: MAIN_DISPLAY.id, events: [{ type: "release-all" }] });
      expect(yield* computer.controller).toBeNull();

      const stale = yield* viewer.input([clickAt(5, 5)]);
      expect(stale.rejected).toEqual([{ index: 0, reason: NOT_CONTROLLING_REASON }]);
      expect(yield* host.delivered).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("stops controlling promptly instead of waiting out a long batch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        // Never resolved anywhere in this test: releasing control has to
        // interrupt the typing rather than wait for it to finish.
        const blocked = yield* Deferred.make<void>();
        const { host, session: computer } = yield* session({
          onInput: (batch) =>
            batch.events[0]?.type === "text"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
              : Effect.void,
        });
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        yield* viewer.takeControl;
        const typing = yield* Effect.forkChild(
          viewer.input([{ type: "text", text: "x".repeat(4096) }]),
        );
        yield* Deferred.await(entered);

        yield* viewer.releaseControl;
        expect(yield* Fiber.join(typing)).toEqual({
          delivered: 0,
          rejected: [{ index: 0, reason: INPUT_CANCELLED_REASON }],
        });
        expect((yield* host.delivered).at(-1)).toEqual({
          displayId: MAIN_DISPLAY.id,
          events: [{ type: "release-all" }],
        });
        expect(yield* computer.controller).toBeNull();

        const agent = yield* computer.agentInput(
          { kind: "agent", threadId: "t", label: "Codex" },
          MAIN_DISPLAY.id,
          [clickAt(1, 1)],
        );
        expect(agent).toEqual({ delivered: 1, rejected: [] });
      }),
    ),
  );

  it.effect("releases what an RPC controller pressed on the display it pressed it on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const client = {
          kind: "viewer",
          viewerId: "rpc:session-1",
          sessionId: "session-1",
          label: "web",
        } as const;

        yield* computer.control(client, "take");
        yield* computer.viewerInput(client, SIDE_DISPLAY.id, [
          { type: "key", key: "ShiftLeft", action: "down" },
        ]);
        yield* computer.control(client, "release");

        // Taking control never named a display; the one the input landed on is
        // the one the modifier has to come back up on.
        expect((yield* host.delivered).at(-1)).toEqual({
          displayId: SIDE_DISPLAY.id,
          events: [{ type: "key", key: "ShiftLeft", action: "up" }],
        });
      }),
    ),
  );

  it.effect(
    "lets go of the display a viewer leaves, keeps its lease, and drops its old frames",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { host, session: computer } = yield* session();
          const viewer = yield* computer.attachViewer({
            label: "Rhys",
            sessionId: "session-rhys",
            canControl: true,
          });
          yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
          yield* viewer.takeControl;
          yield* viewer.input([
            { type: "button", button: "left", action: "down", point: { x: 40, y: 40 } },
          ]);
          // hello, capturing, controller.
          yield* take(viewer, 3);
          yield* host.emitFrame(frame(MAIN_DISPLAY.id, 1));

          yield* viewer.open(SIDE_DISPLAY.id, PROFILE);
          yield* host.emitFrame(frame(SIDE_DISPLAY.id, 2));

          expect((yield* host.delivered).at(-1)).toEqual({
            displayId: MAIN_DISPLAY.id,
            events: [{ type: "button", button: "left", action: "up", point: { x: 40, y: 40 } }],
          });
          // The lease belongs to the person, not the screen they are looking at.
          expect(yield* computer.controller).toMatchObject({ kind: "viewer", label: "Rhys" });

          const seen = yield* take(viewer, 3);
          expect(serverMessages(seen).map((message) => message.type)).toEqual([
            "geometry",
            "status",
          ]);
          expect(seen.filter(isFrame).map((captured) => captured.displayId)).toEqual([
            SIDE_DISPLAY.id,
          ]);
        }),
      ),
  );

  it.effect("keeps window focus and launching with whoever holds control", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* session();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-1",
          canControl: true,
        });
        yield* viewer.open(MAIN_DISPLAY.id, PROFILE);
        yield* viewer.takeControl;
        const window = OpenbotComputerWindowId.make("window-1");
        const agent = { kind: "agent", threadId: "t", label: "Codex" } as const;

        const refused = yield* Effect.flip(computer.focusWindow(agent, window));
        expect(refused.code).toBe("not_controlling");
        expect(yield* host.focused).toEqual([]);

        // The same person's RPC socket: another connection, one lease.
        yield* computer.focusWindow(
          { kind: "viewer", viewerId: "rpc:session-1", sessionId: "session-1", label: "web" },
          window,
        );
        expect(yield* host.focused).toEqual([window]);

        const stranger = yield* Effect.flip(
          computer.focusWindow(
            { kind: "viewer", viewerId: "rpc:session-2", sessionId: "session-2", label: "iPad" },
            window,
          ),
        );
        expect(stranger.code).toBe("not_controlling");

        yield* viewer.releaseControl;
        // Nobody is controlling, so the agent borrows the lease for the call.
        yield* computer.launch(agent, { app: "Safari", displayId: MAIN_DISPLAY.id });
        expect(yield* host.launched).toEqual(["Safari"]);
        expect(yield* computer.controller).toBeNull();
      }),
    ),
  );

  it.effect("reports an unsupported host as unsupported, with the reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* session({
          platform: "unsupported",
          unavailableReason: "Wayland sessions cannot be captured.",
        });
        const status = yield* computer.status;
        expect(status.availability).toBe("unsupported");
        expect(status.detail).toBe("Wayland sessions cannot be captured.");
        expect(status.capabilities.stream).toBe(false);
      }),
    ),
  );
});

describe("captureFrameSize", () => {
  it("downscales to the requested width and keeps the aspect ratio", () => {
    expect(captureFrameSize(MAIN_DISPLAY, 1280)).toEqual({ widthPx: 1280, heightPx: 800 });
  });

  it("never upscales past what the display actually has", () => {
    expect(captureFrameSize(SIDE_DISPLAY, 3840)).toEqual({ widthPx: 1920, heightPx: 1080 });
  });
});

describe("computerAvailability", () => {
  const outcome = { lastCaptureAt: null, lastError: null };
  const description = {
    session: "signed-in-desktop",
    permissions: { screenCapture: "granted", accessibility: "granted", detail: null },
    setup: null,
    capabilities: ALL_CAPABILITIES,
    unavailableReason: null,
  } as const;

  it("blames a missing dependency by name", () => {
    expect(
      computerAvailability({
        platform: "linux",
        describeError: null,
        outcome,
        description: {
          ...description,
          setup: {
            ready: false,
            dependencies: [
              { name: "Xvfb", present: false, path: null, install: "apt install xvfb" },
              { name: "ffmpeg", present: true, path: "/usr/bin/ffmpeg", install: null },
            ],
            notes: ["Install them and restart the server."],
          },
        },
      }),
    ).toEqual({
      availability: "unavailable",
      detail: "This host is missing Xvfb. Install them and restart the server.",
    });
  });

  it("prefers a denied capture grant over the never-tried state", () => {
    expect(
      computerAvailability({
        platform: "darwin",
        describeError: null,
        outcome,
        description: {
          ...description,
          permissions: { screenCapture: "denied", accessibility: "granted", detail: "Ask again." },
        },
      }),
    ).toEqual({ availability: "unavailable", detail: "Ask again." });
  });

  it("stays ready but names the helper to grant when only input is blocked", () => {
    expect(
      computerAvailability({
        platform: "darwin",
        describeError: null,
        outcome: { lastCaptureAt: "2026-09-08T00:00:00.000Z", lastError: null },
        description: {
          ...description,
          permissions: { screenCapture: "granted", accessibility: "denied", detail: null },
        },
      }),
    ).toEqual({ availability: "ready", detail: ACCESSIBILITY_DENIED_DETAIL });
    expect(ACCESSIBILITY_DENIED_DETAIL).toContain("T3 Computer Helper");
    expect(ACCESSIBILITY_DENIED_DETAIL).not.toContain("restart");
  });

  it("prefers the backend's own words over the fallback accessibility copy", () => {
    expect(
      computerAvailability({
        platform: "darwin",
        describeError: null,
        outcome: { lastCaptureAt: "2026-09-08T00:00:00.000Z", lastError: null },
        description: {
          ...description,
          permissions: {
            screenCapture: "granted",
            accessibility: "denied",
            detail: "Grant Accessibility to T3 Computer Helper, then retry.",
          },
        },
      }),
    ).toEqual({
      availability: "ready",
      detail: "Grant Accessibility to T3 Computer Helper, then retry.",
    });
  });

  it("says nothing about permissions on a platform that has no such gate", () => {
    expect(
      computerAvailability({
        platform: "linux",
        describeError: null,
        outcome: { lastCaptureAt: "2026-09-08T00:00:00.000Z", lastError: null },
        description: {
          ...description,
          permissions: {
            screenCapture: "not-applicable",
            accessibility: "not-applicable",
            detail: null,
          },
        },
      }),
    ).toEqual({ availability: "ready", detail: null });
  });
});
