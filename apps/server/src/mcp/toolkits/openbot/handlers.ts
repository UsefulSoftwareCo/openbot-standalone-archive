import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { OpenbotMcpService } from "./OpenbotMcpService.ts";
import { OpenbotToolkit } from "./tools.ts";

const handlers = {
  openbot_prepare_file: (input) =>
    Effect.gen(function* () {
      return yield* (yield* OpenbotMcpService).prepareFile(yield* McpInvocationContext, input);
    }),
  openbot_request_thread: (input) =>
    Effect.gen(function* () {
      return yield* (yield* OpenbotMcpService).requestThread(yield* McpInvocationContext, input);
    }),
  openbot_reply_to_thread: (input) =>
    Effect.gen(function* () {
      return yield* (yield* OpenbotMcpService).replyToThread(yield* McpInvocationContext, input);
    }),
  openbot_get_context: () =>
    Effect.gen(function* () {
      return yield* (yield* OpenbotMcpService).getContext(yield* McpInvocationContext);
    }),
  openbot_update_knowledge: (input) =>
    Effect.gen(function* () {
      return yield* (yield* OpenbotMcpService).updateKnowledge(yield* McpInvocationContext, input);
    }),
  openbot_send_message: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OpenbotMcpService;
      return yield* service.sendMessage(scope, input);
    }),
  openbot_skip_reply: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OpenbotMcpService;
      return yield* service.skipReply(scope, input);
    }),
} satisfies Parameters<typeof OpenbotToolkit.toLayer>[0];

export const OpenbotToolkitHandlersLive = OpenbotToolkit.toLayer(handlers);
