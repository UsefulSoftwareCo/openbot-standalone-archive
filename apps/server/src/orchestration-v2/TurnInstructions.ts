import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
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
  }) => Effect.Effect<string | undefined>;
}>("t3/orchestration-v2/ProviderTurnInstructionsV2", {
  defaultValue: () => ({ resolve: () => Effect.succeed(undefined) }),
}) {}

export function providerMessageWithTurnInstructions(input: {
  readonly instructions: string | undefined;
  readonly userText: string;
}): string {
  const instructions = input.instructions?.trim();
  if (instructions === undefined || instructions.length === 0) {
    return input.userText;
  }
  return `<app_instructions>\n${instructions}\n</app_instructions>\n\n<user_message>\n${input.userText}\n</user_message>`;
}
