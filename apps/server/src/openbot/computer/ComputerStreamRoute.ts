import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  OPENBOT_COMPUTER_STREAM_PATH,
  type OpenbotChannelId,
  type OpenbotComputerDisplay,
  OpenbotComputerError,
  type OpenbotComputerInputEvent,
  OpenbotComputerStreamClientMessage,
  OpenbotComputerStreamServerMessage,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import type { ComputerFrame } from "./ComputerBackend.ts";
import { OpenbotChatComputerService } from "./OpenbotChatComputer.ts";
import { OpenbotComputerSession, type ComputerViewer } from "./OpenbotComputerSession.ts";

/**
 * The frame socket, separate from the RPC socket on purpose: RPC is JSON, and
 * a 12 fps JPEG stream encoded into it would sit in front of every agent call
 * a client makes. It lives under `/ws` so every dev proxy, relay, and tunnel
 * that already carries the RPC socket carries this one unchanged.
 *
 * Text frames in and out are the contract's stream messages; binary frames out
 * are one complete JPEG each. Nothing binary is ever accepted upstream.
 */

/** What a viewer can be handed: JSON for a message, raw bytes for a frame. */
export type ComputerStreamFrame = string | Uint8Array;

const decodeClientMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OpenbotComputerStreamClientMessage),
);
const encodeServerMessage = Schema.encodeUnknownEffect(
  Schema.fromJsonString(OpenbotComputerStreamServerMessage),
);

const isComputerFrame = (
  message: OpenbotComputerStreamServerMessage | ComputerFrame,
): message is ComputerFrame => "jpeg" in message;

/** Everything that reaches the client goes through here, so a frame is bytes
    and a message is one JSON text frame, and nothing else is possible. */
const toStreamFrame = (
  message: OpenbotComputerStreamServerMessage | ComputerFrame,
): Effect.Effect<ComputerStreamFrame> =>
  isComputerFrame(message)
    ? Effect.succeed(message.jpeg)
    : encodeServerMessage(message).pipe(
        // The messages are ours, built from the same schema; an encode failure
        // would be a defect, not something the client can act on.
        Effect.orDie,
      );

const statusFrame = (message: string) => toStreamFrame({ type: "status", state: "error", message });

/**
 * How many control messages may wait for a socket that has stopped reading.
 * Acks, controller changes, and status lines are small and must arrive in
 * order, so they are queued rather than dropped; a client this far behind is
 * not coming back, and the connection is better lost than the process grown.
 */
const OUTBOUND_CONTROL_LIMIT = 256;

/**
 * Runs one viewer's conversation: every message the session produces goes out,
 * and every text frame the client sends is applied to that viewer.
 *
 * Two things keep a slow client from turning into a backlog. Outbound is two
 * lanes, not one queue: control messages keep their order, while frames live
 * in a single latest-frame slot, so a picture that arrives during a write
 * replaces the one waiting instead of joining a queue of JPEGs. Inbound,
 * `input` runs on its own ordered fiber, so stopping control, closing, or a
 * ping is answered while a batch is still being typed rather than behind it.
 *
 * Exposed without a socket so the protocol is testable on its own. The
 * returned stream ends when `inbound` ends or the client says `close`, which
 * is what closes the caller's scope and detaches the viewer.
 */
/**
 * What the socket needs to turn a chat into the one display that chat owns.
 * The socket never carries a display id: a viewer names a chat, and this
 * resolves (and on first use provisions) the chat's managed display. Failing
 * is a value here so the viewer is told why and the conversation continues.
 */
export type ChatDisplayResolver = (
  channelId: OpenbotChannelId,
) => Effect.Effect<OpenbotComputerDisplay, OpenbotComputerError>;

/** Resolves through the chat computer service, provisioning on first use. */
export const chatDisplayResolver =
  (chatComputer: OpenbotChatComputerService["Service"]): ChatDisplayResolver =>
  (channelId) =>
    chatComputer.ensure(channelId).pipe(
      Effect.flatMap((computer) =>
        computer.display === null
          ? Effect.fail(
              new OpenbotComputerError({
                code:
                  computer.state === "unavailable" ? "backend_unavailable" : "display_not_found",
                message:
                  computer.detail ??
                  `${computer.channelName}'s screen is ${computer.state}; try again in a moment.`,
              }),
            )
          : Effect.succeed(computer.display),
      ),
    );

export const handleViewerSocket = (
  viewer: ComputerViewer,
  inbound: Stream.Stream<ComputerStreamFrame>,
  resolveDisplay: ChatDisplayResolver,
): Stream.Stream<ComputerStreamFrame> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const control = yield* Queue.dropping<ComputerStreamFrame, Cause.Done>(
        OUTBOUND_CONTROL_LIMIT,
      );
      const latestFrame = yield* Queue.sliding<ComputerStreamFrame, Cause.Done>(1);
      const finish = Queue.end(control).pipe(Effect.andThen(Queue.end(latestFrame)), Effect.asVoid);

      const send = (frame: Effect.Effect<ComputerStreamFrame>) =>
        frame.pipe(
          Effect.flatMap((value) => Queue.offer(control, value)),
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : Effect.logWarning("openbot computer stream dropped a control message", {
                  viewerId: viewer.viewerId,
                }),
          ),
        );

      const inputs = yield* Queue.make<{
        readonly seq: number;
        readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
      }>();

      const deliver = (batch: {
        readonly seq: number;
        readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
      }) =>
        viewer.input(batch.events).pipe(
          Effect.flatMap((result) =>
            send(toStreamFrame({ type: "input-ack", seq: batch.seq, result })),
          ),
          Effect.catch((error) => send(statusFrame(error.message))),
        );

      const apply = (message: OpenbotComputerStreamClientMessage) => {
        switch (message.type) {
          case "open":
            // The chat is the only selector this socket accepts; the display
            // it resolves to is the chat's own, never a physical screen.
            //
            // Control is given back BEFORE the new chat is resolved. Resolving
            // can take a while (first use provisions a display) and can fail,
            // and a viewer that meant to move to B must not keep driving A in
            // the meantime or afterwards. Releasing also cancels any input
            // still in flight for the old screen, so nothing "resumes" on B.
            return viewer.releaseControl.pipe(
              Effect.andThen(resolveDisplay(message.channelId)),
              Effect.flatMap((display) =>
                viewer.open(display.id, {
                  maxWidthPx: message.maxWidthPx,
                  fps: message.fps,
                  ...(message.quality === undefined ? {} : { quality: message.quality }),
                }),
              ),
              Effect.andThen(message.control ? viewer.takeControl : Effect.void),
              Effect.catch((error) => send(statusFrame(error.message))),
            );
          case "control":
            // Never queued behind input: releasing is what cancels the batch
            // that is running, so waiting for it would defeat the point.
            return (message.action === "take" ? viewer.takeControl : viewer.releaseControl).pipe(
              Effect.catch((error) => send(statusFrame(error.message))),
            );
          case "input":
            return Queue.offer(inputs, { seq: message.seq, events: message.events }).pipe(
              Effect.asVoid,
            );
          case "ping":
            return send(toStreamFrame({ type: "pong", t: message.t }));
          case "close":
            return finish;
        }
      };

      const handle = (frame: ComputerStreamFrame) =>
        typeof frame === "string"
          ? decodeClientMessage(frame).pipe(
              Effect.matchEffect({
                // A client that sends nonsense keeps its stream; it is told
                // what happened and the next frame is still read.
                onFailure: () => send(statusFrame("That message could not be read.")),
                onSuccess: apply,
              }),
            )
          : // Binary upstream is not part of the contract, and silently
            // ignoring it is what keeps a stray frame from killing a session.
            Effect.void;

      yield* Queue.take(inputs).pipe(Effect.flatMap(deliver), Effect.forever, Effect.forkScoped);
      yield* viewer.messages.pipe(
        Stream.runForEach((message) =>
          isComputerFrame(message)
            ? Queue.offer(latestFrame, message.jpeg).pipe(Effect.asVoid)
            : send(toStreamFrame(message)),
        ),
        Effect.andThen(finish),
        Effect.forkScoped,
      );
      yield* inbound.pipe(Stream.runForEach(handle), Effect.andThen(finish), Effect.forkScoped);

      // The writer prefers control: a frame only goes out when nothing ordered
      // is waiting, and the slot it comes from holds the newest picture only.
      // Racing takes rather than the whole lane, so a lane that has already
      // finished cannot end the conversation while the other still has
      // something to say; the stream ends when both are drained and done.
      const next = Effect.gen(function* () {
        const pending = yield* Queue.poll(control);
        if (Option.isSome(pending)) return [pending.value] as const;
        return [yield* Effect.race(Queue.take(control), Queue.take(latestFrame))] as const;
      });
      return Stream.fromPull(Effect.succeed(next));
    }),
  );

const MAX_VIEWER_LABEL_LENGTH = 60;

/** What other viewers see in the controller badge. The client announces it on
    the upgrade URL next to its other identity params; anything missing or
    absurd degrades to a generic name rather than failing the connection, since
    nobody should lose their screen over a label. */
export function viewerLabelFromUrl(url: URL | null): string {
  if (url === null) return "A client";
  const label = url.searchParams.get("clientLabel")?.trim() ?? "";
  if (label !== "" && label.length <= MAX_VIEWER_LABEL_LENGTH) return label;
  const surface = url.searchParams.get("clientSurface")?.trim() ?? "";
  return surface === "" || surface.length > MAX_VIEWER_LABEL_LENGTH ? "A client" : surface;
}

export const openbotComputerStreamRouteLayer = HttpRouter.add(
  "GET",
  OPENBOT_COMPUTER_STREAM_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(AuthOrchestrationReadScope)) {
      return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
    }
    const computer = yield* OpenbotComputerSession;
    const chatComputer = yield* OpenbotChatComputerService;
    const socket = yield* Effect.orDie(request.upgrade);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        const viewer = yield* computer.attachViewer({
          label: viewerLabelFromUrl(Option.getOrNull(HttpServerRequest.toURL(request))),
          // The lease follows the authenticated person, so the control this
          // socket takes also covers the RPC calls their page makes.
          sessionId: session.sessionId,
          // Watching needs read; driving the shared desktop needs operate.
          canControl: session.scopes.includes(AuthOrchestrationOperateScope),
        });
        const received = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
        yield* socket
          .runRaw((frame) => Queue.offer(received, frame))
          .pipe(Effect.ensuring(Queue.end(received)), Effect.ignore, Effect.forkScoped);
        // Ends when the socket closes or the client says so; leaving this
        // effect closes the scope, which detaches the viewer, releases its
        // lease, and stops the capture if it was the last one watching.
        yield* handleViewerSocket(
          viewer,
          Stream.fromQueue(received),
          chatDisplayResolver(chatComputer),
        ).pipe(Stream.runForEach(write));
      }),
    ).pipe(Effect.ignore);

    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
