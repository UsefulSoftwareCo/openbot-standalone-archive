import {
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
    "Send a message to the person in this OpenBot channel. This is the only way they see anything from you: ordinary assistant text is not shown in the channel. Call it once with one coherent reply, or several times for separate useful updates while you work. Never resend text you already delivered in this turn. Only works while this thread's turn is active.",
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
    "Record that the current incoming message needs no reply in this OpenBot channel (for example an acknowledgement, or a request you already answered in this turn). Use this instead of ending the turn silently; a turn that ends with no send and no skip is shown to the person as unanswered.",
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

export const OpenbotToolkit = Toolkit.make(OpenbotSendMessageTool, OpenbotSkipReplyTool);
