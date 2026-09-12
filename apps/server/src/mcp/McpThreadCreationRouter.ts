import type {
  ModelSelection,
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** One thread the generic `create_threads` tool was asked for, already resolved. */
export interface McpThreadCreationRequest {
  /** The thread whose agent called the tool. */
  readonly callerThreadId: ThreadId;
  readonly title: string;
  /** The first message for the new thread; absent when an empty thread was asked for. */
  readonly prompt: string | undefined;
  /** The provider and model the orchestrator resolved for this request. */
  readonly modelSelection: ModelSelection;
  /**
   * The modes the orchestrator resolved against the caller's own, already
   * checked for escalation. A router must create the thread with these.
   */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Deterministic per-request key: the same key must yield the same thread. */
  readonly requestKey: string;
}

/**
 * Lets the app that owns the calling thread create the thread instead.
 *
 * `create_threads` dispatches a plain v2 `thread.create`, which is invisible to
 * an app that keeps its own chat tree: the thread exists but no surface of that
 * app can show it. Rather than teach the orchestrator MCP service about those
 * apps, it resolves the request's provider/model target and offers the request
 * here. Returning `undefined` declines and the plain thread is created exactly
 * as before, so ordinary T3 threads are unchanged. OpenBot provides the only
 * router today (`openbot/OpenbotChannelService.ts`), for chats that belong to
 * an OpenBot project.
 */
export class McpThreadCreationRouter extends Context.Reference<{
  readonly create: (
    request: McpThreadCreationRequest,
  ) => Effect.Effect<{ readonly threadId: ThreadId } | undefined, OrchestratorMcpFailure>;
}>("t3/mcp/McpThreadCreationRouter", {
  defaultValue: () => ({ create: () => Effect.succeed(undefined) }),
}) {}
