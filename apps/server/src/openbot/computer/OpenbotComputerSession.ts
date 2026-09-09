import type {
  OpenbotComputerController,
  OpenbotComputerDisplay,
  OpenbotComputerDisplayCreateInput,
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  OpenbotComputerInputEvent,
  OpenbotComputerInputResult,
  OpenbotComputerLaunchInput,
  OpenbotComputerLaunchResult,
  OpenbotComputerSnapshot,
  OpenbotComputerSnapshotInput,
  OpenbotComputerStatus,
  OpenbotComputerStreamProfile,
  OpenbotComputerStreamServerMessage,
  OpenbotComputerWindow,
  OpenbotComputerWindowId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ComputerFrame } from "./ComputerBackend.ts";

/**
 * The platform-neutral session over one `ComputerBackend`: who is looking,
 * who is controlling, and in what order input reaches the shared desktop.
 *
 * This is the one interface both the WebSocket stream route and the MCP
 * toolkit program against, so the shape is fixed here and implemented in
 * `OpenbotComputerSessionService.ts`.
 */

/** Who an input or lease request comes from. Viewers are humans at a client
    connection; agents are thread tool calls. The label is what other viewers
    see in the controller badge.
 *
 * A viewer carries two identities because one person uses two sockets at once:
 * `viewerId` is this connection, and `sessionId` is the authenticated browser
 * session behind it. The lease belongs to the person (`sessionId`), so the
 * frame socket's lease authorizes the window picker and input the same page
 * sends over RPC; what a connection left pressed belongs to the connection. */
export type ComputerInputSource =
  | {
      readonly kind: "viewer";
      readonly viewerId: string;
      readonly sessionId: string;
      readonly label: string;
    }
  | { readonly kind: "agent"; readonly threadId: string; readonly label: string };

/** A viewer's attachment to one display. Everything a viewer receives (frames
    and control messages) comes through `messages`; the stream ends when the
    viewer is closed. Frames are dropped, never queued, when the viewer falls
    behind. */
export interface ComputerViewer {
  readonly viewerId: string;
  readonly messages: Stream.Stream<OpenbotComputerStreamServerMessage | ComputerFrame>;
  /** Switch this viewer to another display or profile without reconnecting. */
  readonly open: (
    displayId: OpenbotComputerDisplayId,
    profile: OpenbotComputerStreamProfile,
  ) => Effect.Effect<void, OpenbotComputerError>;
  readonly takeControl: Effect.Effect<void, OpenbotComputerError>;
  /**
   * Gives the lease back promptly: any input this viewer still has in flight
   * is cancelled rather than waited for, and everything it left pressed is
   * released on the host before the lease is free for someone else.
   */
  readonly releaseControl: Effect.Effect<void>;
  /** Only accepted while this viewer holds the lease; otherwise every event is
      rejected with `not_controlling` in the result and nothing is delivered. */
  readonly input: (
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) => Effect.Effect<OpenbotComputerInputResult, OpenbotComputerError>;
}

export interface OpenbotComputerSessionShape {
  readonly status: Effect.Effect<OpenbotComputerStatus>;
  /** Current status first, then one entry per change. */
  readonly statusChanges: Stream.Stream<OpenbotComputerStatus>;
  readonly listDisplays: Effect.Effect<ReadonlyArray<OpenbotComputerDisplay>, OpenbotComputerError>;
  readonly listWindows: (
    displayId?: OpenbotComputerDisplayId,
  ) => Effect.Effect<ReadonlyArray<OpenbotComputerWindow>, OpenbotComputerError>;
  /**
   * Raising a window moves focus on the one shared desktop, so it goes through
   * the lease like input does: it fails with `not_controlling` while a
   * different source holds control. Listing windows stays read-only and free.
   */
  readonly focusWindow: (
    source: ComputerInputSource,
    id: OpenbotComputerWindowId,
  ) => Effect.Effect<void, OpenbotComputerError>;
  readonly snapshot: (
    input: OpenbotComputerSnapshotInput,
  ) => Effect.Effect<OpenbotComputerSnapshot, OpenbotComputerError>;
  /**
   * Attach a viewer. Lives as long as the scope; closing the scope releases
   * its lease, releases anything it left pressed, and stops the capture when
   * it was the last viewer of its display.
   */
  readonly attachViewer: (input: {
    readonly label: string;
    /** The authenticated session behind this socket. Two connections that share
        it are one person, so a lease taken here also authorizes their RPC
        focus, launch, and input. */
    readonly sessionId: string;
    /** Whether this connection is allowed to control at all (operate scope). */
    readonly canControl: boolean;
  }) => Effect.Effect<ComputerViewer, OpenbotComputerError, Scope.Scope>;
  /**
   * Agent-side lease and input. Agents never hold the lease across calls: a
   * batch takes it if free, delivers, and releases. While a human holds it,
   * the batch fails with `not_controlling` so the agent can tell the user.
   */
  readonly agentInput: (
    source: Extract<ComputerInputSource, { kind: "agent" }>,
    displayId: OpenbotComputerDisplayId,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) => Effect.Effect<OpenbotComputerInputResult, OpenbotComputerError>;
  /**
   * Human-side input from RPC, for the client that drives the computer over
   * the typed socket rather than the frame socket. Same rule as a stream
   * viewer: without the lease every event comes back rejected.
   */
  readonly viewerInput: (
    source: Extract<ComputerInputSource, { kind: "viewer" }>,
    displayId: OpenbotComputerDisplayId,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) => Effect.Effect<OpenbotComputerInputResult, OpenbotComputerError>;
  /** Human-side lease from RPC (the full-pane view without a stream socket). */
  readonly control: (
    source: Extract<ComputerInputSource, { kind: "viewer" }>,
    action: "take" | "release",
  ) => Effect.Effect<OpenbotComputerStatus, OpenbotComputerError>;
  /**
   * Called when the connection behind a viewer source goes away. Cancels that
   * connection's in-flight input, releases what that connection left pressed,
   * and frees the lease only when THIS connection owns it (`ownerConnection ===
   * sourceKey`); a lease owned by another connection of the same session is
   * left alone.
   *
   * `attachViewer` already does this from its own scope, so this is for the
   * sources that have no viewer record: the typed RPC socket, whose lease and
   * held keys would otherwise outlive the socket that took them.
   */
  readonly detachSource: (
    source: Extract<ComputerInputSource, { kind: "viewer" }>,
  ) => Effect.Effect<void>;
  readonly controller: Effect.Effect<OpenbotComputerController | null>;
  readonly createDisplay: (
    input: OpenbotComputerDisplayCreateInput,
  ) => Effect.Effect<OpenbotComputerDisplay, OpenbotComputerError>;
  readonly destroyDisplay: (
    id: OpenbotComputerDisplayId,
  ) => Effect.Effect<void, OpenbotComputerError>;
  /** Launching activates the new app, so it follows the same lease rule as
      `focusWindow`. */
  readonly launch: (
    source: ComputerInputSource,
    input: OpenbotComputerLaunchInput,
  ) => Effect.Effect<OpenbotComputerLaunchResult, OpenbotComputerError>;
}

export class OpenbotComputerSession extends Context.Service<
  OpenbotComputerSession,
  OpenbotComputerSessionShape
>()("t3/openbot/computer/OpenbotComputerSession") {}
