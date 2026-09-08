import {
  type EnvironmentId,
  OpenbotComputerMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const ALL_MCP_CAPABILITIES = ["preview", "computer", "orchestration", "worktree"] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** Each gated capability answers in its own toolkit's error vocabulary, so a
    withheld capability arrives at the model as the same shape as any other
    failure of that toolkit rather than as a foreign error type. */
const denyCapability = (capability: "preview" | "computer", invocation: McpInvocationScope) =>
  capability === "computer"
    ? new OpenbotComputerMcpFailure({
        code: "unsupported",
        message:
          "This agent session is not allowed to control the computer. Agent computer access is off in T3 Code settings; the person can turn it on under Settings.",
      })
    : new PreviewAutomationUnavailableError({
        capability,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });

const requireCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview" | "computer",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* denyCapability(capability, invocation);
  }
  return invocation;
});

/**
 * Resolves the calling credential's scope, failing when it does not grant
 * `capability`. Overloaded so each caller keeps a single, precise failure type:
 * the preview toolkit never has to handle a computer error and vice versa.
 */
export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "computer",
): Effect.Effect<McpInvocationScope, OpenbotComputerMcpFailure, McpInvocationContext>;
export function requireMcpCapability(
  capability: "preview" | "computer",
): Effect.Effect<
  McpInvocationScope,
  PreviewAutomationUnavailableError | OpenbotComputerMcpFailure,
  McpInvocationContext
> {
  return requireCapability(capability);
}
