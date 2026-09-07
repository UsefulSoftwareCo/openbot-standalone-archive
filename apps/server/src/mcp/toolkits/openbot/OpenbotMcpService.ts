import {
  OpenbotMcpFailure,
  type OpenbotMcpPrepareFileInput,
  type OpenbotMcpPrepareFileResult,
  type OpenbotMcpPeerResult,
  type OpenbotMcpRequestThreadInput,
  type OpenbotMcpReplyToThreadInput,
  type OpenbotThreadContext,
  type OpenbotMcpUpdateKnowledgeInput,
  type OpenbotMcpDeliveryResult,
  type OpenbotMcpSendMessageInput,
  type OpenbotMcpSkipReplyInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenbotChannelService } from "../../../openbot/OpenbotChannelService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

/**
 * MCP surface for explicit channel deliveries. The channel is always the one
 * owning the calling thread (from the credential scope), so a tool call can
 * never deliver into another channel, and a reply target is only accepted
 * when it belongs to that same channel.
 */
export class OpenbotMcpService extends Context.Service<
  OpenbotMcpService,
  {
    readonly prepareFile: (
      scope: McpInvocationScope,
      input: OpenbotMcpPrepareFileInput,
    ) => Effect.Effect<OpenbotMcpPrepareFileResult, OpenbotMcpFailure>;
    readonly requestThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpRequestThreadInput,
    ) => Effect.Effect<OpenbotMcpPeerResult, OpenbotMcpFailure>;
    readonly replyToThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpReplyToThreadInput,
    ) => Effect.Effect<OpenbotMcpPeerResult, OpenbotMcpFailure>;
    readonly getContext: (
      scope: McpInvocationScope,
    ) => Effect.Effect<OpenbotThreadContext, OpenbotMcpFailure>;
    readonly updateKnowledge: (
      scope: McpInvocationScope,
      input: OpenbotMcpUpdateKnowledgeInput,
    ) => Effect.Effect<OpenbotThreadContext, OpenbotMcpFailure>;
    readonly sendMessage: (
      scope: McpInvocationScope,
      input: OpenbotMcpSendMessageInput,
    ) => Effect.Effect<OpenbotMcpDeliveryResult, OpenbotMcpFailure>;
    readonly skipReply: (
      scope: McpInvocationScope,
      input: OpenbotMcpSkipReplyInput,
    ) => Effect.Effect<OpenbotMcpDeliveryResult, OpenbotMcpFailure>;
  }
>()("t3/mcp/toolkits/openbot/OpenbotMcpService") {}

function failure(code: OpenbotMcpFailure["code"], message: string): OpenbotMcpFailure {
  return new OpenbotMcpFailure({ code, message });
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const channels = yield* OpenbotChannelService;

  const record = (
    scope: McpInvocationScope,
    input: {
      readonly kind: "message" | "silence";
      readonly text: string;
      readonly replyToId: string | undefined;
      readonly clientRequestId: string | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const recorded = yield* channels
        .recordDelivery({
          threadId: scope.threadId,
          kind: input.kind,
          text: input.text,
          replyToId: input.replyToId,
          requestKey: `${input.kind}:${encodeURIComponent(requestKey)}`,
        })
        .pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "OpenbotNoActiveRunError":
                return failure(
                  "no_active_run",
                  "This thread has no active turn, so nothing can be delivered right now.",
                );
              case "OpenbotInvalidReplyTargetError":
                return failure(
                  "invalid_reply_target",
                  `replyToMessageId ${error.replyToId} is not a message in this channel. Use an incoming message id from your context or a deliveryId you received from openbot_send_message, or omit it for a general message.`,
                );
              case "OpenbotDeliveryConflictError":
                return failure("request_conflict", error.message);
              case "OpenbotError":
                return error.code === "channel_not_found"
                  ? failure("not_a_channel", "This thread is not an OpenBot channel.")
                  : failure("operation_failed", error.message);
            }
          }),
        );
      return {
        deliveryId: recorded.delivery.id,
        channelId: recorded.delivery.channelId,
        runId: recorded.delivery.runId,
        kind: recorded.delivery.kind,
        replyTo: recorded.delivery.replyTo,
        deliveredInRun: recorded.deliveredInRun,
      } satisfies OpenbotMcpDeliveryResult;
    });

  const ownChannel = Effect.fn(function* (scope: McpInvocationScope) {
    const channel = yield* channels
      .channelForThread(scope.threadId)
      .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
    if (channel === undefined)
      return yield* failure("not_a_channel", "This tool requires an OpenBot main thread.");
    return channel;
  });
  const getContext = Effect.fn(function* (scope: McpInvocationScope) {
    const channel = yield* ownChannel(scope);
    return yield* channels
      .getContext(channel.id)
      .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
  });
  const updateKnowledge = Effect.fn(function* (
    scope: McpInvocationScope,
    input: OpenbotMcpUpdateKnowledgeInput,
  ) {
    const channel = yield* ownChannel(scope);
    const current = yield* getContext(scope);
    return yield* channels
      .updateContext({
        channelId: channel.id,
        expectedRevision: input.expectedRevision,
        instructions: current.instructions,
        knowledge: input.knowledge,
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            error.code === "context_conflict" ? "request_conflict" : "operation_failed",
            error.message,
          ),
        ),
      );
  });

  return OpenbotMcpService.of({
    prepareFile: (scope, input) =>
      channels
        .prepareFile(scope.threadId, input.path)
        .pipe(Effect.mapError((error) => failure("operation_failed", error.message))),
    getContext,
    updateKnowledge,
    requestThread: (scope, input) =>
      channels
        .requestThread(scope.threadId, input)
        .pipe(Effect.mapError((error) => failure("operation_failed", error.message))),
    replyToThread: (scope, input) =>
      channels
        .replyToThread(scope.threadId, input)
        .pipe(Effect.mapError((error) => failure("operation_failed", error.message))),
    sendMessage: (scope, input) =>
      record(scope, {
        kind: "message",
        text: input.text,
        replyToId: input.replyToMessageId,
        clientRequestId: input.clientRequestId,
      }),
    skipReply: (scope, input) =>
      record(scope, {
        kind: "silence",
        text: input.reason ?? "",
        replyToId: undefined,
        clientRequestId: undefined,
      }),
  });
});

export const layer = Layer.effect(OpenbotMcpService, make);
