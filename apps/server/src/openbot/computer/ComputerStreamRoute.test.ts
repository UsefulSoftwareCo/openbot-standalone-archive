import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  OPENBOT_COMPUTER_STREAM_PATH,
  OpenbotChannelId,
  OpenbotComputerError,
  type OpenbotComputerStreamClientMessage,
  type OpenbotComputerStreamServerMessage,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  handleViewerSocket,
  openbotComputerStreamRouteLayer,
  viewerLabelFromUrl,
  type ChatDisplayResolver,
  type ComputerStreamFrame,
} from "./ComputerStreamRoute.ts";
import type { ComputerFrame } from "./ComputerBackend.ts";
import { OpenbotChatComputerService } from "./OpenbotChatComputer.ts";
import { OpenbotComputerSession, type ComputerViewer } from "./OpenbotComputerSession.ts";
import { MAIN_DISPLAY, frame, makeTestSession } from "./OpenbotComputerSessionService.testkit.ts";

const parse = (frame: ComputerStreamFrame): OpenbotComputerStreamServerMessage => {
  if (typeof frame !== "string") throw new Error("expected a text frame");
  return JSON.parse(frame) as OpenbotComputerStreamServerMessage;
};

const send = (message: OpenbotComputerStreamClientMessage): string => JSON.stringify(message);

const CHAT_ID = OpenbotChannelId.make("chat-rhys");

/** The test chat owns the test session's main display; every other chat name
    is refused, which is the whole point of resolving through a chat. */
const resolveTestChat: ChatDisplayResolver = (channelId) =>
  channelId === CHAT_ID
    ? Effect.succeed(MAIN_DISPLAY)
    : Effect.fail(
        new OpenbotComputerError({ code: "display_not_found", message: `no chat ${channelId}` }),
      );

const OPEN_MAIN: OpenbotComputerStreamClientMessage = {
  type: "open",
  channelId: CHAT_ID,
  maxWidthPx: 1280,
  fps: 10,
  control: false,
};

/**
 * Drives `handleViewerSocket` with a scripted set of client frames and reads
 * back exactly `expected` outbound frames.
 */
const converse = (
  script: ReadonlyArray<ComputerStreamFrame>,
  expected: number,
  options: { readonly canControl?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { host, session: computer } = yield* makeTestSession();
    const viewer = yield* computer.attachViewer({
      label: "Rhys",
      sessionId: "session-rhys",
      canControl: options.canControl ?? true,
    });
    const inbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
    const outbound = handleViewerSocket(viewer, Stream.fromQueue(inbound), resolveTestChat);
    for (const value of script) yield* Queue.offer(inbound, value);
    const frames = yield* outbound.pipe(Stream.take(expected), Stream.runCollect);
    return { host, computer, viewer, inbound, frames };
  });

describe("handleViewerSocket", () => {
  it.effect("answers an open with the hello the client needs to size its canvas", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { frames } = yield* converse([send(OPEN_MAIN)], 2);
        expect(parse(frames[0]!)).toMatchObject({
          type: "hello",
          display: { id: MAIN_DISPLAY.id },
          frameWidthPx: 1280,
          frameHeightPx: 800,
          encoding: "image/jpeg",
          controlling: false,
        });
        expect(parse(frames[1]!)).toEqual({
          type: "status",
          state: "capturing",
          message: null,
        });
      }),
    ),
  );

  it.effect("answers a ping with its own timestamp", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { frames } = yield* converse([send({ type: "ping", t: 42 })], 1);
        expect(parse(frames[0]!)).toEqual({ type: "pong", t: 42 });
      }),
    ),
  );

  it.effect("keeps the stream alive when a client sends something unreadable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { frames } = yield* converse(["}}not json{{", send({ type: "ping", t: 7 })], 2);
        expect(parse(frames[0]!)).toMatchObject({ type: "status", state: "error" });
        expect(parse(frames[1]!)).toEqual({ type: "pong", t: 7 });
      }),
    ),
  );

  it.effect("ignores binary frames from the client rather than dropping the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { frames } = yield* converse(
          [new Uint8Array([1, 2, 3]), send({ type: "ping", t: 1 })],
          1,
        );
        expect(parse(frames[0]!)).toEqual({ type: "pong", t: 1 });
      }),
    ),
  );

  it.effect("acknowledges input by sequence, rejecting it when nobody took control", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, frames } = yield* converse(
          [
            send(OPEN_MAIN),
            send({
              type: "input",
              seq: 3,
              events: [{ type: "click", button: "left", count: 1, point: { x: 4, y: 4 } }],
            }),
          ],
          3,
        );
        expect(frames.map(parse).find((message) => message.type === "input-ack")).toEqual({
          type: "input-ack",
          seq: 3,
          result: { delivered: 0, rejected: [{ index: 0, reason: "not controlling" }] },
        });
        expect(yield* host.delivered).toEqual([]);
      }),
    ),
  );

  it.effect("delivers input once the client has taken control", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, frames } = yield* converse(
          [
            send({ ...OPEN_MAIN, control: true }),
            send({
              type: "input",
              seq: 1,
              events: [{ type: "click", button: "left", count: 1, point: { x: 8, y: 9 } }],
            }),
          ],
          4,
        );
        const ack = frames.map(parse).find((message) => message.type === "input-ack");
        expect(ack).toEqual({
          type: "input-ack",
          seq: 1,
          result: { delivered: 1, rejected: [] },
        });
        expect(yield* host.delivered).toHaveLength(1);
      }),
    ),
  );

  it.effect("tells a watch-only client why it cannot take control", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { frames } = yield* converse(
          [send(OPEN_MAIN), send({ type: "control", action: "take" })],
          3,
          { canControl: false },
        );
        const refusal = frames
          .map(parse)
          .find((message) => message.type === "status" && message.state === "error");
        expect(refusal).toMatchObject({
          state: "error",
          message: expect.stringContaining("orchestration:operate"),
        });
      }),
    ),
  );

  it.effect("sends each captured frame as raw bytes, not JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* makeTestSession();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: false,
        });
        const inbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
        const outbound = handleViewerSocket(viewer, Stream.fromQueue(inbound), resolveTestChat);
        yield* Queue.offer(inbound, send(OPEN_MAIN));
        // hello and the capturing status first, then the frame.
        const opening = yield* outbound.pipe(Stream.take(2), Stream.runCollect);
        expect(opening).toHaveLength(2);

        const captured = frame(MAIN_DISPLAY.id, 99);
        yield* host.emitFrame(captured);
        const [bytes] = yield* outbound.pipe(Stream.take(1), Stream.runCollect);
        expect(bytes).toEqual(captured.jpeg);
      }),
    ),
  );

  it.effect(
    "keeps every control message but only the newest picture for a client that stalls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A stub viewer, because what is under test is this route's own two
          // outbound lanes rather than the session that feeds them.
          const pumped = yield* Deferred.make<void>();
          const pictures = Array.from({ length: 50 }, (_, index) =>
            frame(MAIN_DISPLAY.id, index + 1),
          );
          const produced: ReadonlyArray<OpenbotComputerStreamServerMessage | ComputerFrame> = [
            { type: "status", state: "capturing", message: null },
            ...pictures,
            { type: "pong", t: 1 },
            { type: "pong", t: 2 },
            { type: "pong", t: 3 },
          ];
          const viewer: ComputerViewer = {
            viewerId: "viewer-1",
            messages: Stream.fromIterable(produced).pipe(
              Stream.concat(Stream.drain(Stream.fromEffect(Deferred.succeed(pumped, undefined)))),
              Stream.concat(Stream.never),
            ),
            open: () => Effect.void,
            takeControl: Effect.void,
            releaseControl: Effect.void,
            input: () => Effect.succeed({ delivered: 0, rejected: [] }),
          };
          const inbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
          // The client reads one frame and then stops until everything has been
          // produced, which is what a stalled socket looks like from in here.
          const stalled = yield* Ref.make(true);
          const seen = yield* handleViewerSocket(
            viewer,
            Stream.fromQueue(inbound),
            resolveTestChat,
          ).pipe(
            Stream.mapEffect((value) =>
              Ref.getAndSet(stalled, false).pipe(
                Effect.flatMap((wasFirst) =>
                  wasFirst ? Deferred.await(pumped).pipe(Effect.as(value)) : Effect.succeed(value),
                ),
              ),
            ),
            Stream.take(5),
            Stream.runCollect,
          );

          const texts = seen.filter((value): value is string => typeof value === "string");
          expect(texts.map(parse)).toEqual([
            { type: "status", state: "capturing", message: null },
            { type: "pong", t: 1 },
            { type: "pong", t: 2 },
            { type: "pong", t: 3 },
          ]);
          const bytes = seen.filter((value) => typeof value !== "string");
          expect(bytes).toEqual([frame(MAIN_DISPLAY.id, 50).jpeg]);
        }),
      ),
  );

  it.effect("answers a release while the input it is stopping is still in the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        // Never resolved: the release has to cancel the batch, not wait for it.
        const blocked = yield* Deferred.make<void>();
        const { session: computer } = yield* makeTestSession({
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
        const inbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
        const reading = yield* Effect.forkChild(
          handleViewerSocket(viewer, Stream.fromQueue(inbound), resolveTestChat).pipe(
            Stream.take(5),
            Stream.runCollect,
          ),
        );
        yield* Queue.offer(inbound, send({ ...OPEN_MAIN, control: true }));
        yield* Queue.offer(
          inbound,
          send({ type: "input", seq: 1, events: [{ type: "text", text: "x".repeat(4096) }] }),
        );
        yield* Deferred.await(entered);
        yield* Queue.offer(inbound, send({ type: "control", action: "release" }));

        const messages = (yield* Fiber.join(reading)).map(parse);
        expect(messages.findLast((message) => message.type === "controller")).toMatchObject({
          controlling: false,
        });
        expect(messages.find((message) => message.type === "input-ack")).toMatchObject({
          seq: 1,
          result: { delivered: 0 },
        });
      }),
    ),
  );

  it.effect("gives up control of the old screen before switching, even when the switch fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, session: computer } = yield* makeTestSession();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        const inbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
        const reading = yield* Effect.forkChild(
          handleViewerSocket(viewer, Stream.fromQueue(inbound), resolveTestChat).pipe(
            Stream.takeUntil((frame) => typeof frame === "string" && frame.includes('"input-ack"')),
            Stream.runCollect,
          ),
        );
        // Controlling chat A, then asking for a chat this host cannot resolve.
        yield* Queue.offer(inbound, send({ ...OPEN_MAIN, control: true }));
        yield* Queue.offer(
          inbound,
          send({ ...OPEN_MAIN, channelId: OpenbotChannelId.make("chat-nowhere"), control: true }),
        );
        // Input meant for B must not be delivered to A.
        yield* Queue.offer(
          inbound,
          send({ type: "input", seq: 7, events: [{ type: "text", text: "for B" }] }),
        );

        const messages = (yield* Fiber.join(reading)).map(parse);
        expect(messages.some((message) => message.type === "status")).toBe(true);
        expect(messages.findLast((message) => message.type === "controller")).toMatchObject({
          controlling: false,
        });
        expect(messages.find((message) => message.type === "input-ack")).toMatchObject({
          seq: 7,
          result: { delivered: 0 },
        });
        expect(yield* host.delivered).toHaveLength(0);
      }),
    ),
  );

  it.effect("ends the conversation when the client says close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* makeTestSession();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        const inbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
        yield* Queue.offer(inbound, send({ type: "ping", t: 1 }));
        yield* Queue.offer(inbound, send({ type: "close" }));
        // No `take`: the stream has to finish on its own or this never returns.
        const frames = yield* handleViewerSocket(
          viewer,
          Stream.fromQueue(inbound),
          resolveTestChat,
        ).pipe(Stream.runCollect);
        expect(frames.map(parse)).toEqual([{ type: "pong", t: 1 }]);
      }),
    ),
  );

  it.effect("ends the conversation when the socket stops delivering frames", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session: computer } = yield* makeTestSession();
        const viewer = yield* computer.attachViewer({
          label: "Rhys",
          sessionId: "session-rhys",
          canControl: true,
        });
        const inbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
        yield* Queue.offer(inbound, send({ type: "ping", t: 2 }));
        yield* Queue.end(inbound);
        const frames = yield* handleViewerSocket(
          viewer,
          Stream.fromQueue(inbound),
          resolveTestChat,
        ).pipe(Stream.runCollect);
        expect(frames.map(parse)).toEqual([{ type: "pong", t: 2 }]);
      }),
    ),
  );
});

describe("viewerLabelFromUrl", () => {
  const url = (search: string) =>
    new URL(`https://host.test${OPENBOT_COMPUTER_STREAM_PATH}${search}`);

  it("prefers the client's own label", () => {
    expect(viewerLabelFromUrl(url("?clientLabel=Rhys%20on%20iPad"))).toBe("Rhys on iPad");
  });

  it("falls back to the surface, then to something generic", () => {
    expect(viewerLabelFromUrl(url("?clientSurface=mobile"))).toBe("mobile");
    expect(viewerLabelFromUrl(url(""))).toBe("A client");
    expect(viewerLabelFromUrl(null)).toBe("A client");
    expect(viewerLabelFromUrl(url(`?clientLabel=${"x".repeat(200)}`))).toBe("A client");
  });
});

const requestStream = (
  authenticate: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"],
) =>
  Effect.promise(async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(
      openbotComputerStreamRouteLayer.pipe(Layer.provide(NodeServices.layer)),
      { disableLogger: true },
    );
    try {
      return await handler(
        new Request(`https://host.test${OPENBOT_COMPUTER_STREAM_PATH}`),
        Context.make(
          EnvironmentAuth.EnvironmentAuth,
          // SAFETY: the route reaches for nothing else before it answers an
          // unauthorized request; touching anything else would be a defect the
          // test should surface loudly rather than quietly satisfy.
          EnvironmentAuth.EnvironmentAuth.of({
            authenticateWebSocketUpgrade: authenticate,
          } as EnvironmentAuth.EnvironmentAuth["Service"]),
        ).pipe(
          Context.add(
            OpenbotComputerSession,
            OpenbotComputerSession.of({} as OpenbotComputerSession["Service"]),
          ),
          Context.add(
            OpenbotChatComputerService,
            OpenbotChatComputerService.of({} as OpenbotChatComputerService["Service"]),
          ),
        ),
      );
    } finally {
      await dispose();
    }
  });

describe("openbotComputerStreamRouteLayer", () => {
  it.effect("refuses an unauthenticated upgrade", () =>
    Effect.gen(function* () {
      const response = yield* requestStream(() =>
        Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError()),
      );
      expect(response.status).toBe(401);
    }),
  );

  it.effect("refuses a session that may not read the orchestration", () =>
    Effect.gen(function* () {
      const response = yield* requestStream(() =>
        Effect.succeed({
          sessionId: AuthSessionId.make("session-1"),
          subject: "someone",
          method: "browser-session-cookie",
          scopes: [AuthOrchestrationOperateScope],
        } satisfies EnvironmentAuth.AuthenticatedSession),
      );
      expect(response.status).toBe(403);
      const body = (yield* Effect.promise(() => new Response(response.body).json())) as {
        readonly requiredScope?: string;
      };
      expect(body.requiredScope).toBe(AuthOrchestrationReadScope);
    }),
  );
});
