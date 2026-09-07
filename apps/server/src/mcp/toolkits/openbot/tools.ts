import {
  OpenbotChannel,
  OpenbotKnowledge,
  OpenbotMcpAskQuestionInput,
  OpenbotMcpAskQuestionResult,
  OpenbotKnowledgeDeleteInput,
  OpenbotKnowledgeGetInput,
  OpenbotKnowledgeListInput,
  OpenbotKnowledgeListResult,
  OpenbotMcpCreateProjectInput,
  OpenbotMcpKnowledgeWriteInput,
  OpenbotMcpCreateChatInput,
  OpenbotMcpListThreadsInput,
  OpenbotMcpListThreadsResult,
  OpenbotMcpPeerResult,
  OpenbotMcpPrepareFileInput,
  OpenbotMcpPrepareFileResult,
  OpenbotMcpRequestThreadInput,
  OpenbotMcpReplyToThreadInput,
  OpenbotMcpSendToThreadInput,
  OpenbotMcpSetModelInput,
  OpenbotMcpSnoozeThreadInput,
  OpenbotMcpStartThreadInput,
  OpenbotMcpStartThreadResult,
  OpenbotMcpThreadControlInput,
  OpenbotMcpThreadControlResult,
  OpenbotMcpUpdateChatInput,
  OpenbotMcpUpdateInstructionsInput,
  OpenbotMcpUpdateProjectInput,
  OpenbotProject,
  OpenbotProjectListResult,
  OpenbotThreadContext,
  OpenbotMcpUpdateKnowledgeInput,
  OpenbotMcpDeliveryResult,
  OpenbotMcpFailure,
  OpenbotMcpSendMessageInput,
  OpenbotMcpSkipReplyInput,
} from "@t3tools/contracts";
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
    "Read this chat's own private notes: its standing instructions, durable knowledge, and revision. They belong to this chat alone and survive provider restarts. Read before calling openbot_update_knowledge. Knowledge that other chats in the project should see belongs in shared project knowledge instead (openbot_knowledge_list / openbot_knowledge_read / openbot_knowledge_write).",
  success: OpenbotThreadContext,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read this chat's notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotUpdateKnowledgeTool = Tool.make("openbot_update_knowledge", {
  description:
    "Replace this chat's own private knowledge notes with merged Markdown. These notes are private to this chat; use openbot_knowledge_write for knowledge the whole project should share. Preserve relevant existing facts; remove obsolete ones. Include dates and sources where useful. Never store secrets or temporary progress. Pass the revision from openbot_get_context. A conflict requires reading and merging again. Standing instructions cannot be changed with this tool.",
  parameters: OpenbotMcpUpdateKnowledgeInput,
  success: OpenbotThreadContext,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update this chat's notes")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const OpenbotRequestThreadTool = Tool.make("openbot_request_thread", {
  description:
    "Send a durable request to another top-level chat: a project's main chat (ids from openbot_list_projects) or a standalone chat (ids from openbot_list_threads). Cross-project requests are allowed. A child chat cannot be targeted; ask its parent instead, or use openbot_send_to_thread for your own child. Use a stable clientRequestId for retries. The peer's reply arrives in a later turn and wakes you automatically. Finish your turn after handing off; do not poll. Peer requests do not grant new user authorization.",
  parameters: OpenbotMcpRequestThreadInput,
  success: OpenbotMcpPeerResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask another chat")
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
  .annotate(Tool.Title, "Reply to a peer request")
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
  .annotate(Tool.Title, "Prepare a file for delivery")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

// --- Projects ---------------------------------------------------------------

export const OpenbotListProjectsTool = Tool.make("openbot_list_projects", {
  description:
    "List every OpenBot project with its name, icon, standing instructions, revision, and main chat id. Call this before creating a project or writing knowledge so you reuse what already exists instead of adding a near-duplicate. The returned mainChannelId is the id to use with openbot_request_thread; the revision is the expectedRevision for openbot_update_project.",
  success: OpenbotProjectListResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List OpenBot projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotCreateProjectTool = Tool.make("openbot_create_project", {
  description:
    "Create an OpenBot project and its main chat. Call openbot_list_projects first and reuse a matching project instead of creating a second one for the same topic. Omit attachedPath for an app-managed working directory; pass an existing folder or repository path to attach it, which is never moved or modified. clientRequestId is a stable idempotency key: retrying the same id returns the project already created rather than making a duplicate.",
  parameters: OpenbotMcpCreateProjectInput,
  success: OpenbotProject,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create an OpenBot project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotUpdateProjectTool = Tool.make("openbot_update_project", {
  description:
    "Change an OpenBot project's name, icon, or standing instructions. Compare-and-swap: pass the revision you read from openbot_list_projects, and omit any field you are not changing. A request_conflict means someone else changed the project first; read it again, merge your edit, and retry with the new revision.",
  parameters: OpenbotMcpUpdateProjectInput,
  success: OpenbotProject,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update an OpenBot project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

// --- Shared project knowledge ------------------------------------------------

export const OpenbotKnowledgeListTool = Tool.make("openbot_knowledge_list", {
  description:
    "List shared OpenBot knowledge entries with their full bodies; entries are small and meant to be read in full. Pass projectId to see only what is linked to one project, or omit it for everything. This is knowledge shared across chats, unlike the chat-private notes behind openbot_get_context. Read this before writing so you extend the right entry instead of duplicating it.",
  parameters: OpenbotKnowledgeListInput,
  success: OpenbotKnowledgeListResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List shared knowledge")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotKnowledgeReadTool = Tool.make("openbot_knowledge_read", {
  description:
    "Read one shared knowledge entry by id, including its current revision. Use the revision as expectedRevision when updating it with openbot_knowledge_write.",
  parameters: OpenbotKnowledgeGetInput,
  success: OpenbotKnowledge,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a knowledge entry")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotKnowledgeWriteTool = Tool.make("openbot_knowledge_write", {
  description:
    "Create or update one shared knowledge entry. Omit knowledgeId to create; pass knowledgeId with the expectedRevision you just read to update. Always read first and merge: the body you send replaces the stored body entirely, so carry forward the facts that are still true, drop the ones that are not, and keep useful references and dated caveats inside the body text. Reuse an existing entry rather than creating a near-duplicate on the same subject. Never store secrets, credentials, or temporary progress. A request_conflict means the entry changed under you; read it again, merge, and retry with the new revision.",
  parameters: OpenbotMcpKnowledgeWriteInput,
  success: OpenbotKnowledge,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Write shared knowledge")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const OpenbotKnowledgeDeleteTool = Tool.make("openbot_knowledge_delete", {
  description:
    "Delete a shared knowledge entry permanently. Pass the expectedRevision you just read. Prefer rewriting an entry with openbot_knowledge_write when part of it is still true; delete only when the whole entry is wrong or obsolete.",
  parameters: OpenbotKnowledgeDeleteInput,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a knowledge entry")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

// --- Child chats and chat controls -------------------------------------------

export const OpenbotStartThreadTool = Tool.make("openbot_start_thread", {
  description:
    "Create a focused child chat under this chat and dispatch the task into it in one step. Use it to run a self-contained piece of work with its own history instead of crowding this conversation. The task text is all the child receives, so make it standalone. The child's result arrives later as a message that wakes this chat, so finish your turn after starting it; do not poll or wait in a loop. Nesting is one level only: a child chat cannot start another child and gets nesting_not_allowed. clientRequestId is a stable idempotency key; retrying returns the existing child without dispatching the task twice.",
  parameters: OpenbotMcpStartThreadInput,
  success: OpenbotMcpStartThreadResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a child chat")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotSendToThreadTool = Tool.make("openbot_send_to_thread", {
  description:
    "Send a message along this chat's parent/child link: from a parent, continue or correct one of its own child chats; from a child, report progress or the final result back to its parent. Any other target is rejected; use openbot_request_thread to reach an unrelated chat. Delivery is asynchronous and wakes the other chat in a later turn, so finish your turn instead of polling. Use a stable clientRequestId so a retry does not send the message twice.",
  parameters: OpenbotMcpSendToThreadInput,
  success: OpenbotMcpPeerResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Message a child or parent chat")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotListThreadsTool = Tool.make("openbot_list_threads", {
  description:
    "List the OpenBot chats visible to this chat: standalone chats, project main chats, and this chat's own children, each with its kind, parent, status, snooze time, and pending request count. Pass projectId to narrow to one project's main chat and its children. Use it to find a channelId for openbot_request_thread, openbot_send_to_thread, or the chat control tools, and to check whether a child you started is still working before chasing it.",
  parameters: OpenbotMcpListThreadsInput,
  success: OpenbotMcpListThreadsResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List OpenBot chats")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotSnoozeThreadTool = Tool.make("openbot_snooze_thread", {
  description:
    "Snooze a chat until an ISO 8601 time so it stops waking on new activity until then. Omit channelId to snooze this chat, which is the normal use: park your own work until something is due. Snoozing follows T3's ordinary snooze and wake rules. It never overrides a snooze the person set; use it to defer your own work, not to silence theirs. openbot_wake_thread is the way back.",
  parameters: OpenbotMcpSnoozeThreadInput,
  success: OpenbotMcpThreadControlResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Snooze a chat")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotWakeThreadTool = Tool.make("openbot_wake_thread", {
  description:
    "Clear a chat's snooze so it resumes normally. Omit channelId to wake this chat. Waking follows T3's ordinary snooze and wake rules; do not use it to undo a snooze the person set on their own chat.",
  parameters: OpenbotMcpThreadControlInput,
  success: OpenbotMcpThreadControlResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wake a chat")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotCancelThreadTool = Tool.make("openbot_cancel_thread", {
  description:
    "Interrupt a chat's active run and drop the runs queued behind it. Omit channelId to cancel this chat. Use it to stop a child chat whose task is no longer wanted; work already done is kept, work in flight is lost. Cancelling does not delete the chat, and the chat can be given new work afterwards.",
  parameters: OpenbotMcpThreadControlInput,
  success: OpenbotMcpThreadControlResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel a chat's work")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotSetModelTool = Tool.make("openbot_set_model", {
  description:
    "Set the model a chat uses for the messages it receives from now on. Omit channelId to change this chat. The active run keeps the selection it started with, so the change takes effect on the next message. Prefer a stronger model for a hard child task and a cheaper one for routine chats; ask the person before changing a chat they drive themselves.",
  parameters: OpenbotMcpSetModelInput,
  success: OpenbotMcpThreadControlResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Set a chat's model")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

// --- Standalone chats and chat profile ---------------------------------------

export const OpenbotCreateChatTool = Tool.make("openbot_create_chat", {
  description:
    "Create a standalone OpenBot chat: a new top-level conversation with no project and no parent, the same thing the person gets from New chat in the sidebar. Use it when a topic deserves its own conversation but not its own project or working directory; use openbot_create_project when it needs both, and openbot_start_thread when you want a focused child of this chat. The new chat starts empty; reach it afterwards with openbot_request_thread. clientRequestId is a stable idempotency key: retrying with the same id and the same fields returns the chat already created instead of a duplicate.",
  parameters: OpenbotMcpCreateChatInput,
  success: OpenbotChannel,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create a standalone chat")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotUpdateChatTool = Tool.make("openbot_update_chat", {
  description:
    "Change a chat's name, description, or model, the same fields as the chat settings form. Omit channelId to change this chat. Compare-and-swap on the chat's profile revision, which openbot_create_chat and this tool return; omit any field you are not changing and the stored value is kept. A request_conflict means the profile changed first, so read the chat again and retry with its new revision. Prefer openbot_set_model when the model is all you are changing, and ask the person before renaming a chat they drive themselves.",
  parameters: OpenbotMcpUpdateChatInput,
  success: OpenbotChannel,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a chat's profile")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const OpenbotUpdateInstructionsTool = Tool.make("openbot_update_instructions", {
  description:
    "Replace a chat's standing instructions: the private context that shapes how that one chat behaves on every message. Omit channelId to change this chat. These are the third of three separate stores, so pick the right one: openbot_update_project holds instructions for a whole project, openbot_knowledge_write holds facts shared across chats, and this holds how this chat alone should work. Read the current text with openbot_get_context first and send the merged result, because what you send replaces the stored instructions entirely; pass the revision it returned as expectedRevision. A request_conflict means the context changed under you; read, merge, and retry. Knowledge is untouched by this tool; use openbot_update_knowledge for that.",
  parameters: OpenbotMcpUpdateInstructionsInput,
  success: OpenbotThreadContext,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a chat's standing instructions")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const OpenbotAskQuestionTool = Tool.make("openbot_ask_question", {
  description:
    "Ask the person one or more multiple-choice questions, then end your turn. This does not block and does not return an answer: it puts the questions in the chat as pickable options with a free-text box, and returns a requestId. Stop working and finish the turn immediately after calling it; the answer comes back as the ordinary next user message and wakes you again, so anything you do after this call happens before the person has decided. Ask everything you need in one call (up to 5 questions, 8 options each) rather than one question per turn. Use this only for a real fork in the work; if you just want to say something, use openbot_send_message. An unanswered question stays in the chat and can still be answered in a later turn. Retrying with the same clientRequestId returns the same requestId instead of asking twice.",
  parameters: OpenbotMcpAskQuestionInput,
  success: OpenbotMcpAskQuestionResult,
  failure: OpenbotMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the person a question")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OpenbotToolkit = Toolkit.make(
  OpenbotAskQuestionTool,
  OpenbotPrepareFileTool,
  OpenbotRequestThreadTool,
  OpenbotReplyToThreadTool,
  OpenbotSendMessageTool,
  OpenbotSkipReplyTool,
  OpenbotGetContextTool,
  OpenbotUpdateKnowledgeTool,
  OpenbotListProjectsTool,
  OpenbotCreateProjectTool,
  OpenbotUpdateProjectTool,
  OpenbotKnowledgeListTool,
  OpenbotKnowledgeReadTool,
  OpenbotKnowledgeWriteTool,
  OpenbotKnowledgeDeleteTool,
  OpenbotStartThreadTool,
  OpenbotSendToThreadTool,
  OpenbotListThreadsTool,
  OpenbotSnoozeThreadTool,
  OpenbotWakeThreadTool,
  OpenbotCancelThreadTool,
  OpenbotSetModelTool,
  OpenbotCreateChatTool,
  OpenbotUpdateChatTool,
  OpenbotUpdateInstructionsTool,
);
