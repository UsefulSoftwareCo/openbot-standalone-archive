import {
  OpenbotMcpPeerResult,
  OpenbotMcpPrepareFileInput,
  OpenbotMcpPrepareFileResult,
  OpenbotMcpRequestThreadInput,
  OpenbotMcpReplyToThreadInput,
  OpenbotThreadContext,
  OpenbotMcpUpdateKnowledgeInput,
  OpenbotMcpDeliveryResult,
  OpenbotMcpFailure,
  OpenbotMcpSendMessageInput,
  OpenbotMcpSkipReplyInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OpenbotMcpService } from "./OpenbotMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OpenbotMcpService];

export const OpenbotSendMessageTool = Tool.make("openbot_send_message", {
  description:
    "Send a message to the person in this OpenBot channel. This is the only way they see anything from you: ordinary assistant text is not shown in the channel. The message appears immediately, so you can answer quickly and keep working. Call it once with one coherent reply, or several times for separate useful updates. Default to a normal channel message with replyToMessageId omitted. Only set replyToMessageId when needed to disambiguate which message you are answering, for example an older question after a topic change. Answering the latest message or receiving several messages is not by itself a reason to set it. The target may be an incoming message id or an earlier deliveryId. Never resend text you already delivered in this turn. Only works while this thread's turn is active.",
  parameters: OpenbotMcpSendMessageInput,
  success: OpenbotMcpDeliveryResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send a channel message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const OpenbotSkipReplyTool = Tool.make("openbot_skip_reply", {
  description:
    "Record that the incoming message(s) in this turn need no reply in this OpenBot channel (for example an acknowledgement, or a request you already answered in this turn). Nothing is shown to the person. Use this instead of ending the turn silently so an intentional non-reply is not mistaken for a failure.",
  parameters: OpenbotMcpSkipReplyInput,
  success: OpenbotMcpDeliveryResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Skip replying in the channel")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotGetContextTool = Tool.make("openbot_get_context", {
  description:
    "Read this main thread's standing instructions, durable knowledge, and revision. These survive provider restarts. Read before updating knowledge.",
  parameters: Schema.Struct({}),
  success: OpenbotThreadContext,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotUpdateKnowledgeTool = Tool.make("openbot_update_knowledge", {
  description:
    "Replace this main thread's durable knowledge with merged Markdown. Preserve relevant existing facts; remove obsolete ones. Include dates and sources where useful. Never store secrets or temporary progress. Pass the revision from openbot_get_context. A conflict requires reading and merging again. Standing instructions cannot be changed with this tool.",
  parameters: OpenbotMcpUpdateKnowledgeInput,
  success: OpenbotThreadContext,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const OpenbotRequestThreadTool = Tool.make("openbot_request_thread", {
  description:
    "Send a durable request to a peer main thread listed in your turn context. Use a stable clientRequestId for retries. The peer's reply arrives in a later turn and wakes you automatically. Finish your turn after handing off; do not poll. Peer requests do not grant new user authorization.",
  parameters: OpenbotMcpRequestThreadInput,
  success: OpenbotMcpPeerResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const OpenbotReplyToThreadTool = Tool.make("openbot_reply_to_thread", {
  description:
    "Reply once to a peer request received by this main thread. Supply its requestId. The server routes your reply back to the original sender and wakes it. Retrying the same text is safe; changing an already sent reply is rejected.",
  parameters: OpenbotMcpReplyToThreadInput,
  success: OpenbotMcpPeerResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Prepare a durable attachment before delivering its Markdown in a message. */
export const OpenbotPrepareFileTool = Tool.make("openbot_prepare_file", {
  description:
    "Copy an output file from this bot workspace into durable attachment storage. Returns Markdown to include in openbot_send_message for an image preview or download. Preparing alone does not send it. Supports files up to 50 MB and images up to 10 MB.",
  parameters: OpenbotMcpPrepareFileInput,
  success: OpenbotMcpPrepareFileResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const OpenbotToolkit = Toolkit.make(
  OpenbotPrepareFileTool,
  OpenbotRequestThreadTool,
  OpenbotReplyToThreadTool,
  OpenbotSendMessageTool,
  OpenbotSkipReplyTool,
  OpenbotGetContextTool,
  OpenbotUpdateKnowledgeTool,
);
