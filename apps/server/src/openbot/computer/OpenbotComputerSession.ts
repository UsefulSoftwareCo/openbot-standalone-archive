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
    see in the controller badge. */
export type ComputerInputSource =
  | { readonly kind: "viewer"; readonly viewerId: string; readonly label: string }
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
  readonly focusWindow: (id: OpenbotComputerWindowId) => Effect.Effect<void, OpenbotComputerError>;
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
  readonly controller: Effect.Effect<OpenbotComputerController | null>;
  readonly createDisplay: (
    input: OpenbotComputerDisplayCreateInput,
  ) => Effect.Effect<OpenbotComputerDisplay, OpenbotComputerError>;
  readonly destroyDisplay: (
    id: OpenbotComputerDisplayId,
  ) => Effect.Effect<void, OpenbotComputerError>;
  readonly launch: (
    input: OpenbotComputerLaunchInput,
  ) => Effect.Effect<OpenbotComputerLaunchResult, OpenbotComputerError>;
}

export class OpenbotComputerSession extends Context.Service<
  OpenbotComputerSession,
  OpenbotComputerSessionShape
>()("t3/openbot/computer/OpenbotComputerSession") {}
