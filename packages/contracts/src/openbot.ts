import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

/**
 * OpenBot channels. A channel is an app-owned conversation that maps 1:1 onto
 * an Orchestrator v2 thread. Every incoming message is a v2 user message, and
 * every user-visible reply is an explicit delivery the agent records through
 * the `openbot_send_message` tool. Ordinary assistant output stays internal.
 */
export const OpenbotChannelId = TrimmedNonEmptyString.pipe(Schema.brand("OpenbotChannelId"));
export type OpenbotChannelId = typeof OpenbotChannelId.Type;

export const OpenbotDeliveryId = TrimmedNonEmptyString.pipe(Schema.brand("OpenbotDeliveryId"));
export type OpenbotDeliveryId = typeof OpenbotDeliveryId.Type;

export const OpenbotChannelName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const OpenbotChannel = Schema.Struct({
  id: OpenbotChannelId,
  name: OpenbotChannelName,
  projectId: ProjectId,
  threadId: ThreadId,
  modelSelection: ModelSelection,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type OpenbotChannel = typeof OpenbotChannel.Type;

/** Where one accepted message is in its lifecycle. */
export const OpenbotMessageState = Schema.Literals(["pending", "working", "handled", "failed"]);
export type OpenbotMessageState = typeof OpenbotMessageState.Type;

/**
 * How a handled message ended. `replied` means at least one delivery was sent
 * during its run; `silent` means the agent explicitly declined to reply;
 * `no_reply` means the run finished without either, which the UI surfaces as
 * an unanswered request rather than hiding it.
 */
export const OpenbotMessageOutcome = Schema.Literals(["replied", "silent", "no_reply", "failed"]);
export type OpenbotMessageOutcome = typeof OpenbotMessageOutcome.Type;

export const OpenbotIncomingMessage = Schema.Struct({
  id: MessageId,
  runId: Schema.NullOr(RunId),
  runStatus: Schema.NullOr(OrchestrationV2RunStatus),
  text: Schema.String,
  createdAt: Schema.String,
  state: OpenbotMessageState,
  outcome: Schema.NullOr(OpenbotMessageOutcome),
  error: Schema.NullOr(Schema.String),
});
export type OpenbotIncomingMessage = typeof OpenbotIncomingMessage.Type;

export const OpenbotDeliveryKind = Schema.Literals(["message", "silence"]);
export type OpenbotDeliveryKind = typeof OpenbotDeliveryKind.Type;

export const OpenbotDelivery = Schema.Struct({
  id: OpenbotDeliveryId,
  channelId: OpenbotChannelId,
  runId: RunId,
  kind: OpenbotDeliveryKind,
  text: Schema.String,
  createdAt: Schema.String,
});
export type OpenbotDelivery = typeof OpenbotDelivery.Type;

export const OpenbotChannelStatus = Schema.Literals(["idle", "working", "waiting", "failed"]);
export type OpenbotChannelStatus = typeof OpenbotChannelStatus.Type;

export const OpenbotChannelView = Schema.Struct({
  channel: OpenbotChannel,
  status: OpenbotChannelStatus,
  /** Messages accepted but not yet started. */
  pendingCount: Schema.Int,
  messages: Schema.Array(OpenbotIncomingMessage),
  deliveries: Schema.Array(OpenbotDelivery),
});
export type OpenbotChannelView = typeof OpenbotChannelView.Type;

export const OpenbotChannelListResult = Schema.Struct({
  channels: Schema.Array(OpenbotChannel),
});
export type OpenbotChannelListResult = typeof OpenbotChannelListResult.Type;

export const OpenbotChannelCreateInput = Schema.Struct({
  name: OpenbotChannelName,
  commandId: Schema.optional(CommandId),
  modelSelection: Schema.optional(ModelSelection),
});
export type OpenbotChannelCreateInput = typeof OpenbotChannelCreateInput.Type;

export const OpenbotChannelSubscribeInput = Schema.Struct({
  channelId: OpenbotChannelId,
});
export type OpenbotChannelSubscribeInput = typeof OpenbotChannelSubscribeInput.Type;

export const OpenbotChannelSendInput = Schema.Struct({
  channelId: OpenbotChannelId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  /** Client-allocated so retries after a dropped socket cannot double-send. */
  messageId: Schema.optional(MessageId),
  commandId: Schema.optional(CommandId),
});
export type OpenbotChannelSendInput = typeof OpenbotChannelSendInput.Type;

export const OpenbotChannelSendResult = Schema.Struct({
  channelId: OpenbotChannelId,
  messageId: MessageId,
  runId: RunId,
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued"]),
});
export type OpenbotChannelSendResult = typeof OpenbotChannelSendResult.Type;

export class OpenbotError extends Schema.TaggedErrorClass<OpenbotError>()("OpenbotError", {
  code: Schema.Literals([
    "channel_not_found",
    "no_provider_available",
    "project_unavailable",
    "orchestration_error",
  ]),
  message: Schema.String,
  channelId: Schema.optional(OpenbotChannelId),
  cause: Schema.optional(Schema.Defect()),
}) {}

// MCP tool contracts. The calling thread is resolved from the MCP credential,
// never from tool input, so an agent can only deliver into its own channel.
export const OpenbotMcpSendMessageInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(60_000)).annotate({
    description: "The complete message the user will see in the channel.",
  }),
  clientRequestId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description: "Stable idempotency key to reuse when retrying this send.",
    }),
  ),
});
export type OpenbotMcpSendMessageInput = typeof OpenbotMcpSendMessageInput.Type;

export const OpenbotMcpSkipReplyInput = Schema.Struct({
  reason: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)).annotate({
      description: "Short internal note on why no reply is needed. Not shown to the user.",
    }),
  ),
});
export type OpenbotMcpSkipReplyInput = typeof OpenbotMcpSkipReplyInput.Type;

export const OpenbotMcpDeliveryResult = Schema.Struct({
  deliveryId: OpenbotDeliveryId,
  channelId: OpenbotChannelId,
  runId: RunId,
  kind: OpenbotDeliveryKind,
  /** Deliveries recorded so far in this run, including this one. */
  deliveredInRun: Schema.Int,
});
export type OpenbotMcpDeliveryResult = typeof OpenbotMcpDeliveryResult.Type;

export class OpenbotMcpFailure extends Schema.TaggedErrorClass<OpenbotMcpFailure>()(
  "OpenbotMcpFailure",
  {
    code: Schema.Literals(["not_a_channel", "no_active_run", "operation_failed"]),
    message: Schema.String,
  },
) {}
