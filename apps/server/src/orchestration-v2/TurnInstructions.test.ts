import {
  MessageId,
  NodeId,
  RunId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { providerMessageWithTurnInstructions, runMessagesInOrder } from "./TurnInstructions.ts";

it("collects a run's messages in arrival order, scoped to its root node", () => {
  const runId = RunId.make("run:1");
  const rootNodeId = NodeId.make("node:1");
  const at = (millis: number) => DateTime.makeUnsafe(millis);
  const stored = (
    id: string,
    input: Partial<OrchestrationV2ConversationMessage> & { readonly createdAt: DateTime.Utc },
  ): OrchestrationV2ConversationMessage => ({
    id: MessageId.make(id),
    threadId: "thread:1" as never,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: id,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    updatedAt: input.createdAt,
    ...input,
  });
  const projection = {
    messages: [
      stored("late", { createdAt: at(30) }),
      stored("primary", { createdAt: at(10) }),
      stored("assistant", { createdAt: at(15), role: "assistant" }),
      stored("other-run", { createdAt: at(12), runId: RunId.make("run:2") }),
      stored("superseded", { createdAt: at(11), nodeId: NodeId.make("node:old") }),
      stored("early", { createdAt: at(20) }),
    ],
  };
  expect(
    runMessagesInOrder(projection, {
      id: runId,
      rootNodeId,
      userMessageId: MessageId.make("primary"),
    }).map((message) => message.id),
  ).toEqual(["primary", "early", "late"]);
});

const messages = [
  { id: MessageId.make("message:one"), text: "first" },
  { id: MessageId.make("message:two"), text: "second\nline" },
  { id: MessageId.make("message:three"), text: "third" },
];

it("passes ordinary thread text through untouched when no app instructions apply", () => {
  expect(
    providerMessageWithTurnInstructions({ instructions: undefined, messages: [messages[0]!] }),
  ).toBe("first");
  expect(providerMessageWithTurnInstructions({ instructions: "   ", messages })).toBe(
    "first\n\nsecond\nline\n\nthird",
  );
});

it("wraps every grouped message in its own tagged block, in order, with its id", () => {
  expect(providerMessageWithTurnInstructions({ instructions: "Be brief.", messages })).toBe(
    [
      "<app_instructions>",
      "Be brief.",
      "</app_instructions>",
      "",
      '<user_message id="message:one">',
      "first",
      "</user_message>",
      "",
      '<user_message id="message:two">',
      "second",
      "line",
      "</user_message>",
      "",
      '<user_message id="message:three">',
      "third",
      "</user_message>",
    ].join("\n"),
  );
});
