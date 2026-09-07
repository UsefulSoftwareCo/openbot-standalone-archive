import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";
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

/** A small local avatar: emoji/initials or a resized image; never a remote tracking URL. */
export const OpenbotAvatar = Schema.String.check(
  Schema.isMaxLength(70000),
  Schema.isPattern(/^(?:[^\r\n]{0,16}|data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)$/),
);
export const OpenbotDescription = Schema.String.check(Schema.isMaxLength(2000));
export const OpenbotChannel = Schema.Struct({
  id: OpenbotChannelId,
  name: OpenbotChannelName,
  avatar: OpenbotAvatar,
  description: OpenbotDescription,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
  attachments: Schema.Array(ChatAttachment),
  createdAt: Schema.String,
  state: OpenbotMessageState,
  outcome: Schema.NullOr(OpenbotMessageOutcome),
  error: Schema.NullOr(Schema.String),
});
export type OpenbotIncomingMessage = typeof OpenbotIncomingMessage.Type;

export const OpenbotDeliveryKind = Schema.Literals(["message", "silence"]);
export type OpenbotDeliveryKind = typeof OpenbotDeliveryKind.Type;

/**
 * What a delivery replies to: an accepted incoming message, or an earlier
 * message delivery in the same channel. Always scoped to the delivery's own
 * channel; the server rejects any other target before recording.
 */
export const OpenbotReplyTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }),
  Schema.Struct({ type: Schema.Literal("delivery"), deliveryId: OpenbotDeliveryId }),
]);
export type OpenbotReplyTarget = typeof OpenbotReplyTarget.Type;

export const OpenbotDelivery = Schema.Struct({
  id: OpenbotDeliveryId,
  channelId: OpenbotChannelId,
  runId: RunId,
  kind: OpenbotDeliveryKind,
  text: Schema.String,
  replyTo: Schema.NullOr(OpenbotReplyTarget),
  createdAt: Schema.String,
});
export type OpenbotDelivery = typeof OpenbotDelivery.Type;

export const OpenbotChannelStatus = Schema.Literals(["idle", "working", "waiting", "failed"]);
export type OpenbotChannelStatus = typeof OpenbotChannelStatus.Type;

export const OpenbotChannelView = Schema.Struct({
  channel: OpenbotChannel,
  status: OpenbotChannelStatus,
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
  avatar: Schema.optional(OpenbotAvatar),
  description: Schema.optional(OpenbotDescription),
  commandId: Schema.optional(CommandId),
  modelSelection: Schema.optional(ModelSelection),
});
export type OpenbotChannelCreateInput = typeof OpenbotChannelCreateInput.Type;

/** Compare-and-swap profile updates preserve edits from other devices. */
export const OpenbotChannelUpdateInput = Schema.Struct({
  channelId: OpenbotChannelId,
  name: OpenbotChannelName,
  avatar: OpenbotAvatar,
  description: OpenbotDescription,
  modelSelection: ModelSelection,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OpenbotChannelUpdateInput = typeof OpenbotChannelUpdateInput.Type;

export const OpenbotChannelSubscribeInput = Schema.Struct({
  channelId: OpenbotChannelId,
});
export type OpenbotChannelSubscribeInput = typeof OpenbotChannelSubscribeInput.Type;

export const OpenbotChannelSendInput = Schema.Struct({
  channelId: OpenbotChannelId,
  text: Schema.String.check(Schema.isMaxLength(120_000)),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
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
    "peer_request_invalid",
    "context_conflict",
    "profile_conflict",
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
  replyToMessageId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
      description:
        "Omit by default. Set only when needed to disambiguate which message you are answering, such as an older question after a topic change. Do not set merely because this is a direct answer or several messages arrived. Use an incoming message id or an earlier deliveryId.",
    }),
  ),
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
  replyTo: Schema.NullOr(OpenbotReplyTarget),
  /** Deliveries recorded so far in this run, including this one. */
  deliveredInRun: Schema.Int,
});
export type OpenbotMcpDeliveryResult = typeof OpenbotMcpDeliveryResult.Type;

export class OpenbotMcpFailure extends Schema.TaggedErrorClass<OpenbotMcpFailure>()(
  "OpenbotMcpFailure",
  {
    code: Schema.Literals([
      "not_a_channel",
      "no_active_run",
      "invalid_reply_target",
      "request_conflict",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}

/** Main-thread context is independent of provider session history. */
export const OpenbotThreadInstructions = Schema.String.check(Schema.isMaxLength(16_000));
export const OpenbotThreadKnowledge = Schema.String.check(Schema.isMaxLength(32_000));
export const OpenbotThreadContext = Schema.Struct({
  threadId: ThreadId,
  instructions: OpenbotThreadInstructions,
  knowledge: OpenbotThreadKnowledge,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OpenbotThreadContext = typeof OpenbotThreadContext.Type;
export const OpenbotContextUpdateInput = Schema.Struct({
  channelId: OpenbotChannelId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  instructions: OpenbotThreadInstructions,
  knowledge: OpenbotThreadKnowledge,
});
export type OpenbotContextUpdateInput = typeof OpenbotContextUpdateInput.Type;
export const OpenbotMcpUpdateKnowledgeInput = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  knowledge: OpenbotThreadKnowledge,
});
export type OpenbotMcpUpdateKnowledgeInput = typeof OpenbotMcpUpdateKnowledgeInput.Type;

export const OpenbotMcpRequestThreadInput = Schema.Struct({
  channelId: OpenbotChannelId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type OpenbotMcpRequestThreadInput = typeof OpenbotMcpRequestThreadInput.Type;
export const OpenbotMcpReplyToThreadInput = Schema.Struct({
  requestId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
});
export type OpenbotMcpReplyToThreadInput = typeof OpenbotMcpReplyToThreadInput.Type;
export const OpenbotMcpPeerResult = Schema.Struct({
  requestId: MessageId,
  messageId: MessageId,
  channelId: OpenbotChannelId,
});
export type OpenbotMcpPeerResult = typeof OpenbotMcpPeerResult.Type;

/** A durable file copy the agent can include in a normal channel message. */
export const OpenbotMcpPrepareFileInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)).annotate({
    description:
      "Path to a file inside this thread's workspace. Copy external outputs into the workspace first.",
  }),
});
export type OpenbotMcpPrepareFileInput = typeof OpenbotMcpPrepareFileInput.Type;
export const OpenbotMcpPrepareFileResult = Schema.Struct({
  attachment: ChatAttachment,
  markdown: Schema.String,
});
export type OpenbotMcpPrepareFileResult = typeof OpenbotMcpPrepareFileResult.Type;

/** Stable attachment references are stored in message text; access URLs are minted by each client. */
export function openbotAttachmentHref(attachment: ChatAttachment): string {
  return `/openbot-attachment/${encodeURIComponent(JSON.stringify(attachment))}`;
}
/** Parse only OpenBot attachment links; invalid links remain ordinary message text. */
export function parseOpenbotAttachmentHref(href: string): ChatAttachment | undefined {
  if (!href.startsWith("/openbot-attachment/")) return undefined;
  try {
    const parsed = Schema.decodeUnknownOption(ChatAttachment)(
      JSON.parse(decodeURIComponent(href.slice("/openbot-attachment/".length))),
    );
    return parsed._tag === "Some" ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}
