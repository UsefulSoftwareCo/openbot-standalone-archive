import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2RunStatus, OrchestrationV2UserInputQuestion } from "./orchestrationV2.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "./providerPolicy.ts";

/**
 * OpenBot chats. A channel is an app-owned conversation that maps 1:1 onto an
 * Orchestrator v2 thread. Every chat is the same primitive: a standalone chat,
 * a project's main chat (the project references it), or a child chat that
 * belongs to a parent chat. Every incoming message is a v2 user message, and
 * every user-visible reply is an explicit delivery the agent records through
 * the `openbot_send_message` tool. Ordinary assistant output stays internal.
 */
export const OpenbotChannelId = TrimmedNonEmptyString.pipe(Schema.brand("OpenbotChannelId"));
export type OpenbotChannelId = typeof OpenbotChannelId.Type;

export const OpenbotProjectId = TrimmedNonEmptyString.pipe(Schema.brand("OpenbotProjectId"));
export type OpenbotProjectId = typeof OpenbotProjectId.Type;

export const OpenbotKnowledgeId = TrimmedNonEmptyString.pipe(Schema.brand("OpenbotKnowledgeId"));
export type OpenbotKnowledgeId = typeof OpenbotKnowledgeId.Type;

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

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
  revision: Revision,
  /** The T3 project whose workspace root is this chat's cwd. */
  projectId: ProjectId,
  threadId: ThreadId,
  modelSelection: ModelSelection,
  /** Set on a child chat. One level only: a parent never has a parent itself. */
  parentChannelId: Schema.NullOr(OpenbotChannelId),
  /** The OpenBot project this chat belongs to, or null for a standalone chat and its children. */
  openbotProjectId: Schema.NullOr(OpenbotProjectId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type OpenbotChannel = typeof OpenbotChannel.Type;

/**
 * Derived role of a chat. `main` means an OpenBot project references it as its
 * main chat; `child` means it has a parent; otherwise `standalone`.
 */
export type OpenbotChannelKind = "standalone" | "main" | "child";
export function openbotChannelKind(
  channel: Pick<OpenbotChannel, "parentChannelId">,
  projects: ReadonlyArray<Pick<OpenbotProject, "mainChannelId">>,
  channelId: OpenbotChannelId,
): OpenbotChannelKind {
  if (channel.parentChannelId !== null) return "child";
  return projects.some((project) => project.mainChannelId === channelId) ? "main" : "standalone";
}

/** Phosphor icon name in PascalCase without the `Icon` suffix, e.g. `Basket`. Never a sparkle. */
export const OpenbotProjectIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^(?!Sparkle)[A-Z][A-Za-z0-9]*$/),
);
export const OpenbotProjectIconColor = Schema.Literals([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
]);
export type OpenbotProjectIconColor = typeof OpenbotProjectIconColor.Type;
export const OpenbotProjectIcon = Schema.Struct({
  name: OpenbotProjectIconName,
  color: OpenbotProjectIconColor,
});
export type OpenbotProjectIcon = typeof OpenbotProjectIcon.Type;
export const DEFAULT_OPENBOT_PROJECT_ICON: OpenbotProjectIcon = {
  name: "Folder",
  color: "default",
};

/**
 * A product project is distinct from its execution working directory. A
 * `managed` workspace is an app-owned directory under the OpenBot state dir
 * (no user folder needed to create a project). An `attached` workspace is a
 * user-selected repository or folder that is never moved or modified by OpenBot.
 */
export const OpenbotProjectWorkspace = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("managed"), path: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("attached"), path: TrimmedNonEmptyString }),
]);
export type OpenbotProjectWorkspace = typeof OpenbotProjectWorkspace.Type;

export const OpenbotProjectName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export const OpenbotProjectInstructions = Schema.String.check(Schema.isMaxLength(16_000));

export const OpenbotProject = Schema.Struct({
  id: OpenbotProjectId,
  name: OpenbotProjectName,
  icon: OpenbotProjectIcon,
  instructions: OpenbotProjectInstructions,
  revision: Revision,
  /** The T3 project that owns the workspace root used as cwd by every chat in this project. */
  t3ProjectId: ProjectId,
  /** The project's main chat (its channel). Child chats belong to this chat, not to the project. */
  mainChannelId: OpenbotChannelId,
  workspace: OpenbotProjectWorkspace,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type OpenbotProject = typeof OpenbotProject.Type;

export const OpenbotProjectListResult = Schema.Struct({
  projects: Schema.Array(OpenbotProject),
});
export type OpenbotProjectListResult = typeof OpenbotProjectListResult.Type;

export const OpenbotProjectCreateInput = Schema.Struct({
  name: OpenbotProjectName,
  icon: Schema.optional(OpenbotProjectIcon),
  instructions: Schema.optional(OpenbotProjectInstructions),
  /** Attach an existing folder or repository. Omit for an app-managed working directory. */
  attachedPath: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  /** Idempotency key; a retry with the same id returns the first project. */
  commandId: Schema.optional(CommandId),
});
export type OpenbotProjectCreateInput = typeof OpenbotProjectCreateInput.Type;

/** Compare-and-swap. Omitted fields keep their saved value. */
export const OpenbotProjectUpdateInput = Schema.Struct({
  projectId: OpenbotProjectId,
  expectedRevision: Revision,
  name: Schema.optional(OpenbotProjectName),
  icon: Schema.optional(OpenbotProjectIcon),
  instructions: Schema.optional(OpenbotProjectInstructions),
});
export type OpenbotProjectUpdateInput = typeof OpenbotProjectUpdateInput.Type;

export const OpenbotProjectGetInput = Schema.Struct({ projectId: OpenbotProjectId });
export type OpenbotProjectGetInput = typeof OpenbotProjectGetInput.Type;

/**
 * Durable knowledge with stable identity. One record can be relevant to several
 * projects; links guide retrieval and never grant access. Useful references and
 * caveats live in the body text.
 */
export const OpenbotKnowledgeTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const OpenbotKnowledgeBody = Schema.String.check(Schema.isMaxLength(64_000));
export const OpenbotKnowledge = Schema.Struct({
  id: OpenbotKnowledgeId,
  title: OpenbotKnowledgeTitle,
  body: OpenbotKnowledgeBody,
  /** Project that maintains this entry; null when unowned. Reserved for future access boundaries. */
  ownerProjectId: Schema.NullOr(OpenbotProjectId),
  /** Projects this entry is relevant to. Includes the owner when it has one. */
  projectIds: Schema.Array(OpenbotProjectId),
  revision: Revision,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type OpenbotKnowledge = typeof OpenbotKnowledge.Type;

export const OpenbotKnowledgeListInput = Schema.Struct({
  /** Restrict to entries linked to this project. Omit for every entry. */
  projectId: Schema.optional(OpenbotProjectId),
});
export type OpenbotKnowledgeListInput = typeof OpenbotKnowledgeListInput.Type;
export const OpenbotKnowledgeListResult = Schema.Struct({
  entries: Schema.Array(OpenbotKnowledge),
});
export type OpenbotKnowledgeListResult = typeof OpenbotKnowledgeListResult.Type;
export const OpenbotKnowledgeGetInput = Schema.Struct({ knowledgeId: OpenbotKnowledgeId });
export type OpenbotKnowledgeGetInput = typeof OpenbotKnowledgeGetInput.Type;
export const OpenbotKnowledgeCreateInput = Schema.Struct({
  title: OpenbotKnowledgeTitle,
  body: OpenbotKnowledgeBody,
  ownerProjectId: Schema.optional(Schema.NullOr(OpenbotProjectId)),
  projectIds: Schema.optional(Schema.Array(OpenbotProjectId)),
  /** Idempotency key; a retry with the same id returns the first entry. */
  commandId: Schema.optional(CommandId),
});
export type OpenbotKnowledgeCreateInput = typeof OpenbotKnowledgeCreateInput.Type;
/** Compare-and-swap. Omitted fields keep their saved value; `projectIds` replaces the link set. */
export const OpenbotKnowledgeUpdateInput = Schema.Struct({
  knowledgeId: OpenbotKnowledgeId,
  expectedRevision: Revision,
  title: Schema.optional(OpenbotKnowledgeTitle),
  body: Schema.optional(OpenbotKnowledgeBody),
  ownerProjectId: Schema.optional(Schema.NullOr(OpenbotProjectId)),
  projectIds: Schema.optional(Schema.Array(OpenbotProjectId)),
});
export type OpenbotKnowledgeUpdateInput = typeof OpenbotKnowledgeUpdateInput.Type;
export const OpenbotKnowledgeDeleteInput = Schema.Struct({
  knowledgeId: OpenbotKnowledgeId,
  expectedRevision: Revision,
});
export type OpenbotKnowledgeDeleteInput = typeof OpenbotKnowledgeDeleteInput.Type;

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

/**
 * A pending interactive request on the chat's thread, derived from the v2
 * runtime requests. Answers go back through `runtime-request.respond` on the
 * same thread, so the shared question and approval UI is reused unchanged.
 */
export const OpenbotPendingRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("approval"),
    requestId: RuntimeRequestId,
    requestKind: ProviderRequestKind,
    createdAt: Schema.String,
    detail: Schema.optional(Schema.String),
    appName: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(ProviderApprovalOption)),
    /** `not_resumable` means the provider session is gone; the UI must show it as expired. */
    responseCapability: Schema.Literals(["live", "not_resumable"]),
  }),
  Schema.Struct({
    type: Schema.Literal("user_input"),
    requestId: RuntimeRequestId,
    createdAt: Schema.String,
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
    responseCapability: Schema.Literals(["live", "message", "not_resumable"]),
  }),
]);
export type OpenbotPendingRequest = typeof OpenbotPendingRequest.Type;

export const OpenbotRespondInput = Schema.Struct({
  channelId: OpenbotChannelId,
  requestId: RuntimeRequestId,
  decision: Schema.optional(ProviderApprovalDecision),
  answers: Schema.optional(ProviderUserInputAnswers),
  commandId: Schema.optional(CommandId),
});
export type OpenbotRespondInput = typeof OpenbotRespondInput.Type;

/**
 * Thread controls the UI and the agent tools share. Both surfaces call the
 * same service operation, so "Stop" in the UI and openbot_cancel_thread do
 * exactly the same thing: interrupt the active run and cancel queued runs.
 */
export const OpenbotChannelControlInput = Schema.Struct({ channelId: OpenbotChannelId });
export type OpenbotChannelControlInput = typeof OpenbotChannelControlInput.Type;
export const OpenbotChannelSnoozeInput = Schema.Struct({
  channelId: OpenbotChannelId,
  /** ISO 8601 instant. Wake follows T3's existing snooze rules. */
  until: TrimmedNonEmptyString,
});
export type OpenbotChannelSnoozeInput = typeof OpenbotChannelSnoozeInput.Type;
export const OpenbotChannelSetModelInput = Schema.Struct({
  channelId: OpenbotChannelId,
  modelSelection: ModelSelection,
});
export type OpenbotChannelSetModelInput = typeof OpenbotChannelSetModelInput.Type;

export const OpenbotChannelView = Schema.Struct({
  channel: OpenbotChannel,
  status: OpenbotChannelStatus,
  messages: Schema.Array(OpenbotIncomingMessage),
  deliveries: Schema.Array(OpenbotDelivery),
  pendingRequests: Schema.Array(OpenbotPendingRequest),
  /** ISO time until which the thread is snoozed, or null. Mirrors the v2 thread state. */
  snoozedUntil: Schema.NullOr(Schema.String),
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
  /** Create a child chat of this parent. The parent must not itself be a child. */
  parentChannelId: Schema.optional(OpenbotChannelId),
});
export type OpenbotChannelCreateInput = typeof OpenbotChannelCreateInput.Type;

/**
 * Start a focused child chat under a parent and dispatch its first work
 * request in one durable step. The request is queued on the child through
 * the ordinary v2 queue; the result returns to the parent as a reply message.
 */
export const OpenbotThreadStartInput = Schema.Struct({
  parentChannelId: OpenbotChannelId,
  title: OpenbotChannelName,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  modelSelection: Schema.optional(ModelSelection),
  /** Idempotency key: a retry returns the first child and does not dispatch again. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type OpenbotThreadStartInput = typeof OpenbotThreadStartInput.Type;
export const OpenbotThreadStartResult = Schema.Struct({
  channel: OpenbotChannel,
  requestId: MessageId,
  messageId: MessageId,
  /** True when this call created the child; false when the request key replayed. */
  created: Schema.Boolean,
});
export type OpenbotThreadStartResult = typeof OpenbotThreadStartResult.Type;

export const OpenbotChannelListInput = Schema.Struct({});

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
    "project_not_found",
    "knowledge_not_found",
    "knowledge_conflict",
    "nesting_not_allowed",
    "request_not_found",
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
      "not_found",
      "nesting_not_allowed",
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
/** Standalone chat creation and profile edits, so the assistant can do what the sidebar does. */
export const OpenbotMcpCreateChatInput = Schema.Struct({
  name: OpenbotChannelName,
  description: Schema.optional(OpenbotDescription),
  modelSelection: Schema.optional(ModelSelection),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
    description: "Stable idempotency key so a retry cannot create a duplicate chat.",
  }),
});
export type OpenbotMcpCreateChatInput = typeof OpenbotMcpCreateChatInput.Type;
export const OpenbotMcpUpdateChatInput = Schema.Struct({
  channelId: Schema.optional(
    OpenbotChannelId.annotate({ description: "Defaults to the calling chat." }),
  ),
  expectedRevision: Revision,
  name: Schema.optional(OpenbotChannelName),
  description: Schema.optional(OpenbotDescription),
  modelSelection: Schema.optional(ModelSelection),
});
export type OpenbotMcpUpdateChatInput = typeof OpenbotMcpUpdateChatInput.Type;
/** Standing instructions live in the chat's private context (openbot_thread_context), separate from knowledge. */
export const OpenbotMcpUpdateInstructionsInput = Schema.Struct({
  channelId: Schema.optional(
    OpenbotChannelId.annotate({ description: "Defaults to the calling chat." }),
  ),
  expectedRevision: Revision,
  instructions: OpenbotThreadInstructions,
});
export type OpenbotMcpUpdateInstructionsInput = typeof OpenbotMcpUpdateInstructionsInput.Type;

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
  channelId: OpenbotChannelId.annotate({
    description:
      "Target chat id. Use a project's main chat (from openbot_list_projects) or a standalone chat. A child chat cannot be targeted directly; the receiving chat chooses its own thread.",
  }),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type OpenbotMcpRequestThreadInput = typeof OpenbotMcpRequestThreadInput.Type;

/** Agent-side equivalents of the UI operations. Same host operations and validation. */
export const OpenbotMcpStartThreadInput = Schema.Struct({
  title: OpenbotChannelName.annotate({ description: "Short title for the focused child chat." }),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)).annotate({
    description: "Self-contained work request dispatched into the new child chat.",
  }),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
    description:
      "Stable idempotency key. A retry returns the existing child without dispatching again.",
  }),
  modelSelection: Schema.optional(ModelSelection),
});
export type OpenbotMcpStartThreadInput = typeof OpenbotMcpStartThreadInput.Type;
export const OpenbotMcpStartThreadResult = Schema.Struct({
  channelId: OpenbotChannelId,
  threadId: ThreadId,
  requestId: MessageId,
  created: Schema.Boolean,
});
export type OpenbotMcpStartThreadResult = typeof OpenbotMcpStartThreadResult.Type;

export const OpenbotMcpSendToThreadInput = Schema.Struct({
  channelId: OpenbotChannelId.annotate({
    description: "A child chat of the calling chat, or the parent of the calling child chat.",
  }),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type OpenbotMcpSendToThreadInput = typeof OpenbotMcpSendToThreadInput.Type;

export const OpenbotMcpThreadSummary = Schema.Struct({
  channelId: OpenbotChannelId,
  threadId: ThreadId,
  name: Schema.String,
  kind: Schema.Literals(["standalone", "main", "child"]),
  parentChannelId: Schema.NullOr(OpenbotChannelId),
  openbotProjectId: Schema.NullOr(OpenbotProjectId),
  status: OpenbotChannelStatus,
  snoozedUntil: Schema.NullOr(Schema.String),
  pendingRequests: Schema.Int,
  /** Profile revision, the expectedRevision for openbot_update_chat. */
  revision: Revision,
  modelSelection: ModelSelection,
  updatedAt: Schema.String,
});
export type OpenbotMcpThreadSummary = typeof OpenbotMcpThreadSummary.Type;
export const OpenbotMcpListThreadsInput = Schema.Struct({
  /** Restrict to one project's main chat and its children. Omit for chats visible to the caller. */
  projectId: Schema.optional(OpenbotProjectId),
});
export type OpenbotMcpListThreadsInput = typeof OpenbotMcpListThreadsInput.Type;
export const OpenbotMcpListThreadsResult = Schema.Struct({
  threads: Schema.Array(OpenbotMcpThreadSummary),
});
export type OpenbotMcpListThreadsResult = typeof OpenbotMcpListThreadsResult.Type;

export const OpenbotMcpThreadControlInput = Schema.Struct({
  channelId: Schema.optional(
    OpenbotChannelId.annotate({ description: "Defaults to the calling chat." }),
  ),
});
export type OpenbotMcpThreadControlInput = typeof OpenbotMcpThreadControlInput.Type;
export const OpenbotMcpSnoozeThreadInput = Schema.Struct({
  channelId: Schema.optional(OpenbotChannelId),
  /** ISO 8601 time. Wake follows T3's existing snooze rules; nothing overrides a user's snooze. */
  until: TrimmedNonEmptyString,
});
export type OpenbotMcpSnoozeThreadInput = typeof OpenbotMcpSnoozeThreadInput.Type;
export const OpenbotMcpSetModelInput = Schema.Struct({
  channelId: Schema.optional(OpenbotChannelId),
  modelSelection: ModelSelection,
});
export type OpenbotMcpSetModelInput = typeof OpenbotMcpSetModelInput.Type;
export const OpenbotMcpThreadControlResult = Schema.Struct({
  channelId: OpenbotChannelId,
  threadId: ThreadId,
  status: OpenbotChannelStatus,
  snoozedUntil: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
});
export type OpenbotMcpThreadControlResult = typeof OpenbotMcpThreadControlResult.Type;

export const OpenbotMcpCreateProjectInput = Schema.Struct({
  name: OpenbotProjectName,
  icon: Schema.optional(OpenbotProjectIcon),
  instructions: Schema.optional(OpenbotProjectInstructions),
  attachedPath: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Existing folder or repository to attach as the working directory. Omit for an app-managed directory.",
    }),
  ),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
    description: "Stable idempotency key so a retry cannot create a duplicate project.",
  }),
});
export type OpenbotMcpCreateProjectInput = typeof OpenbotMcpCreateProjectInput.Type;
export const OpenbotMcpUpdateProjectInput = OpenbotProjectUpdateInput;
export type OpenbotMcpUpdateProjectInput = typeof OpenbotMcpUpdateProjectInput.Type;
export const OpenbotMcpKnowledgeWriteInput = Schema.Struct({
  /** Omit to create. Provide with expectedRevision to update. */
  knowledgeId: Schema.optional(OpenbotKnowledgeId),
  expectedRevision: Schema.optional(Revision),
  title: OpenbotKnowledgeTitle,
  body: OpenbotKnowledgeBody,
  ownerProjectId: Schema.optional(Schema.NullOr(OpenbotProjectId)),
  projectIds: Schema.optional(Schema.Array(OpenbotProjectId)),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type OpenbotMcpKnowledgeWriteInput = typeof OpenbotMcpKnowledgeWriteInput.Type;
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
