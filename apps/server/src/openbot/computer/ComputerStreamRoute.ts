import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  OPENBOT_COMPUTER_STREAM_PATH,
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
 * Runs one viewer's conversation: every message the session produces goes out,
 * and every text frame the client sends is applied to that viewer.
 *
 * Exposed without a socket so the protocol is testable on its own. The
 * returned stream ends when `inbound` ends or the client says `close`, which
 * is what closes the caller's scope and detaches the viewer.
 */
export const handleViewerSocket = (
  viewer: ComputerViewer,
  inbound: Stream.Stream<ComputerStreamFrame>,
): Stream.Stream<ComputerStreamFrame> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const outbound = yield* Queue.make<ComputerStreamFrame, Cause.Done>();
      const send = (frame: Effect.Effect<ComputerStreamFrame>) =>
        frame.pipe(
          Effect.flatMap((value) => Queue.offer(outbound, value)),
          Effect.asVoid,
        );

      const apply = (message: OpenbotComputerStreamClientMessage) => {
        switch (message.type) {
          case "open":
            return viewer
              .open(message.displayId, {
                maxWidthPx: message.maxWidthPx,
                fps: message.fps,
                ...(message.quality === undefined ? {} : { quality: message.quality }),
              })
              .pipe(
                Effect.andThen(message.control ? viewer.takeControl : Effect.void),
                Effect.catch((error) => send(statusFrame(error.message))),
              );
          case "control":
            return (message.action === "take" ? viewer.takeControl : viewer.releaseControl).pipe(
              Effect.catch((error) => send(statusFrame(error.message))),
            );
          case "input":
            return viewer.input(message.events).pipe(
              Effect.flatMap((result) =>
                send(toStreamFrame({ type: "input-ack", seq: message.seq, result })),
              ),
              Effect.catch((error) => send(statusFrame(error.message))),
            );
          case "ping":
            return send(toStreamFrame({ type: "pong", t: message.t }));
          case "close":
            return Queue.end(outbound).pipe(Effect.asVoid);
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

      yield* viewer.messages.pipe(
        Stream.runForEach((message) => send(toStreamFrame(message))),
        Effect.andThen(Queue.end(outbound)),
        Effect.forkScoped,
      );
      yield* inbound.pipe(
        Stream.runForEach(handle),
        Effect.andThen(Queue.end(outbound)),
        Effect.forkScoped,
      );
      return Stream.fromQueue(outbound);
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
    const socket = yield* Effect.orDie(request.upgrade);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        const viewer = yield* computer.attachViewer({
          label: viewerLabelFromUrl(Option.getOrNull(HttpServerRequest.toURL(request))),
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
        yield* handleViewerSocket(viewer, Stream.fromQueue(received)).pipe(
          Stream.runForEach(write),
        );
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
