import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { OpenbotMcpService } from "./OpenbotMcpService.ts";
import { OpenbotToolkit } from "./tools.ts";

const handlers = {
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
