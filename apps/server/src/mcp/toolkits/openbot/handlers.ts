import * as Effect from "effect/Effect";

import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { OpenbotMcpService } from "./OpenbotMcpService.ts";
import { OpenbotToolkit } from "./tools.ts";

/**
 * Every OpenBot tool is the same shape: resolve the calling thread's scope from
 * the MCP credential, then hand it to one service operation. The scope is never
 * read from tool input, so a tool call cannot act as another chat.
 */
const call = <A, E>(
  run: (service: OpenbotMcpService["Service"], scope: McpInvocationScope) => Effect.Effect<A, E>,
): Effect.Effect<A, E, OpenbotMcpService | McpInvocationContext> =>
  Effect.flatMap(OpenbotMcpService, (service) =>
    Effect.flatMap(McpInvocationContext, (scope) => run(service, scope)),
  );

const handlers = {
  openbot_prepare_file: (input) => call((service, scope) => service.prepareFile(scope, input)),
  openbot_request_thread: (input) => call((service, scope) => service.requestThread(scope, input)),
  openbot_reply_to_thread: (input) => call((service, scope) => service.replyToThread(scope, input)),
  openbot_ask_question: (input) => call((service, scope) => service.askQuestion(scope, input)),
  openbot_get_context: () => call((service, scope) => service.getContext(scope)),
  openbot_update_knowledge: (input) =>
    call((service, scope) => service.updateKnowledge(scope, input)),
  openbot_send_message: (input) => call((service, scope) => service.sendMessage(scope, input)),
  openbot_skip_reply: (input) => call((service, scope) => service.skipReply(scope, input)),
  openbot_list_projects: () => call((service, scope) => service.listProjects(scope)),
  openbot_create_project: (input) => call((service, scope) => service.createProject(scope, input)),
  openbot_update_project: (input) => call((service, scope) => service.updateProject(scope, input)),
  openbot_search_icons: (input) => call((service, scope) => service.searchIcons(scope, input)),
  openbot_knowledge_list: (input) => call((service, scope) => service.knowledgeList(scope, input)),
  openbot_knowledge_read: (input) => call((service, scope) => service.knowledgeRead(scope, input)),
  openbot_knowledge_write: (input) =>
    call((service, scope) => service.knowledgeWrite(scope, input)),
  openbot_knowledge_delete: (input) =>
    call((service, scope) => service.knowledgeDelete(scope, input)),
  openbot_start_thread: (input) => call((service, scope) => service.startThread(scope, input)),
  openbot_send_to_thread: (input) => call((service, scope) => service.sendToThread(scope, input)),
  openbot_list_threads: (input) => call((service, scope) => service.listThreads(scope, input)),
  openbot_snooze_thread: (input) => call((service, scope) => service.snoozeThread(scope, input)),
  openbot_wake_thread: (input) => call((service, scope) => service.wakeThread(scope, input)),
  openbot_cancel_thread: (input) => call((service, scope) => service.cancelThread(scope, input)),
  openbot_set_model: (input) => call((service, scope) => service.setModel(scope, input)),
  openbot_create_chat: (input) => call((service, scope) => service.createChat(scope, input)),
  openbot_update_chat: (input) => call((service, scope) => service.updateChat(scope, input)),
  openbot_update_instructions: (input) =>
    call((service, scope) => service.updateInstructions(scope, input)),
  openbot_delete_chat: (input) => call((service, scope) => service.deleteChat(scope, input)),
  openbot_delete_project: (input) => call((service, scope) => service.deleteProject(scope, input)),
} satisfies Parameters<typeof OpenbotToolkit.toLayer>[0];

export const OpenbotToolkitHandlersLive = OpenbotToolkit.toLayer(handlers);
