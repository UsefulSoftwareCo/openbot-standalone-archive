import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/**
 * App-owned instructions prepended to the provider prompt of every root turn.
 *
 * Orchestration stays unaware of which app owns a thread; an app (OpenBot
 * channels today) provides this hook to describe its conversation contract to
 * the agent. The stored user message is untouched, so timelines show what
 * the user typed and only the provider sees the wrapper. The default resolves
 * to nothing, which leaves ordinary T3 threads exactly as before.
 */
export class ProviderTurnInstructionsV2 extends Context.Reference<{
  readonly resolve: (input: {
    readonly threadId: ThreadId;
    readonly runOrdinal: number;
    /** How many user messages this turn carries; more than one when queued messages were grouped. */
    readonly messageCount: number;
  }) => Effect.Effect<string | undefined>;
}>("t3/orchestration-v2/ProviderTurnInstructionsV2", {
  defaultValue: () => ({ resolve: () => Effect.succeed(undefined) }),
}) {}

export interface TurnInstructionMessage {
  readonly id: MessageId;
  readonly text: string;
}

/**
 * Every user message a root run consumes, in arrival order: the run's own
 * message first, then any that joined the run while it was queued. Scoped to
 * the run's root node so a restarted run's superseded input stays out.
 */
export function runMessagesInOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  run: Pick<OrchestrationV2Run, "id" | "rootNodeId" | "userMessageId">,
): ReadonlyArray<OrchestrationV2ConversationMessage> {
  const primary = projection.messages.find((message) => message.id === run.userMessageId);
  const joined = projection.messages
    .filter(
      (message) =>
        message.id !== run.userMessageId &&
        message.role === "user" &&
        message.runId === run.id &&
        message.nodeId === run.rootNodeId,
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  return primary === undefined ? joined : [primary, ...joined];
}

/**
 * Renders the prompt text for a root turn. Without instructions the user text
 * is passed through untouched (grouped messages are joined with a blank line).
 * With instructions every message is wrapped in its own tagged block carrying
 * its id, so an app can let the agent address a specific message later.
 */
export function providerMessageWithTurnInstructions(input: {
  readonly instructions: string | undefined;
  readonly messages: ReadonlyArray<TurnInstructionMessage>;
}): string {
  const instructions = input.instructions?.trim();
  if (instructions === undefined || instructions.length === 0) {
    return input.messages.map((message) => message.text).join("\n\n");
  }
  const blocks = input.messages.map(
    (message) => `<user_message id="${message.id}">\n${message.text}\n</user_message>`,
  );
  return `<app_instructions>\n${instructions}\n</app_instructions>\n\n${blocks.join("\n\n")}`;
}
