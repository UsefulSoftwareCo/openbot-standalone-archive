import type {
  OpenbotChannelId,
  OpenbotChatComputer,
  OpenbotComputerError,
  OpenbotComputerInputEvent,
  OpenbotComputerInputResult,
  OpenbotComputerLaunchResult,
  OpenbotComputerSnapshot,
  OpenbotComputerWindowId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ComputerInputSource } from "./OpenbotComputerSession.ts";

/**
 * The computer a chat owns: one managed display per top-level chat, created
 * the first time it is asked for and kept for the life of the server. This is
 * the surface the client rail, the expanded view, and the agent tools all use,
 * so nothing above it ever names a raw display id. It sits on top of
 * `OpenbotComputerSession`, which keeps the lease, ordering, capture, and
 * cleanup exactly as before; this layer only decides *which* display a chat
 * means and refuses anything aimed at a display the chat does not own.
 *
 * A child chat resolves to its parent's computer. The chain is one level deep
 * by the channel invariant; a longer or cyclic chain is a data error and is
 * reported, not followed.
 */
export interface OpenbotChatComputerShape {
  /** Describe without provisioning. `idle` when nothing has asked yet. */
  readonly get: (
    channelId: OpenbotChannelId,
  ) => Effect.Effect<OpenbotChatComputer, OpenbotComputerError>;
  /**
   * Provision on first use, then describe. Concurrent callers for the same
   * chat share one creation; a second display is never made for a chat that
   * already has one.
   */
  readonly ensure: (
    channelId: OpenbotChannelId,
  ) => Effect.Effect<OpenbotChatComputer, OpenbotComputerError>;
  /** Current state first, then one entry per change relevant to this chat. */
  readonly changes: (channelId: OpenbotChannelId) => Stream.Stream<OpenbotChatComputer>;
  /** The chat that owns the computer a thread's agent works on. */
  readonly channelForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OpenbotChannelId, OpenbotComputerError>;
  /** Read-only: never focuses, never moves the pointer. Provisions if needed. */
  readonly snapshot: (
    channelId: OpenbotChannelId,
    maxWidthPx: number | undefined,
  ) => Effect.Effect<OpenbotComputerSnapshot, OpenbotComputerError>;
  /** Only windows on the chat's own display; anything else is `window_not_found`. */
  readonly focusWindow: (
    source: ComputerInputSource,
    channelId: OpenbotChannelId,
    windowId: OpenbotComputerWindowId,
  ) => Effect.Effect<void, OpenbotComputerError>;
  /**
   * Launches onto the chat's display. Fails with `permission_denied` when the
   * host cannot place the window there (macOS without Accessibility), rather
   * than letting it land on the user's own screen.
   */
  readonly launch: (
    source: ComputerInputSource,
    channelId: OpenbotChannelId,
    input: { readonly app: string; readonly args?: ReadonlyArray<string> | undefined },
  ) => Effect.Effect<OpenbotComputerLaunchResult, OpenbotComputerError>;
  /** Input aimed at the chat's display, through the session's lease rules. */
  readonly input: (
    source: ComputerInputSource,
    channelId: OpenbotChannelId,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) => Effect.Effect<OpenbotComputerInputResult, OpenbotComputerError>;
}

export class OpenbotChatComputerService extends Context.Service<
  OpenbotChatComputerService,
  OpenbotChatComputerShape
>()("t3/openbot/computer/OpenbotChatComputer/OpenbotChatComputerService") {}
