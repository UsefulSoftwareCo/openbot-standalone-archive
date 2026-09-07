import {
  OpenbotMcpFailure,
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
 * never deliver into another channel.
 */
export class OpenbotMcpService extends Context.Service<
  OpenbotMcpService,
  {
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
          requestKey: `${input.kind}:${encodeURIComponent(requestKey)}`,
        })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag === "OpenbotNoActiveRunError") {
              return failure(
                "no_active_run",
                "This thread has no active turn, so nothing can be delivered right now.",
              );
            }
            return error.code === "channel_not_found"
              ? failure("not_a_channel", "This thread is not an OpenBot channel.")
              : failure("operation_failed", error.message);
          }),
        );
      return {
        deliveryId: recorded.delivery.id,
        channelId: recorded.delivery.channelId,
        runId: recorded.delivery.runId,
        kind: recorded.delivery.kind,
        deliveredInRun: recorded.deliveredInRun,
      } satisfies OpenbotMcpDeliveryResult;
    });

  return OpenbotMcpService.of({
    sendMessage: (scope, input) =>
      record(scope, { kind: "message", text: input.text, clientRequestId: input.clientRequestId }),
    skipReply: (scope, input) =>
      record(scope, { kind: "silence", text: input.reason ?? "", clientRequestId: undefined }),
  });
});

export const layer = Layer.effect(OpenbotMcpService, make);
