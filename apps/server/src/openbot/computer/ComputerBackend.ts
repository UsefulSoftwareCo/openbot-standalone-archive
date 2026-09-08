import type {
  OpenbotComputerCapabilities,
  OpenbotComputerDisplay,
  OpenbotComputerDisplayCreateInput,
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  OpenbotComputerInputEvent,
  OpenbotComputerInputResult,
  OpenbotComputerLaunchInput,
  OpenbotComputerLaunchResult,
  OpenbotComputerPermissions,
  OpenbotComputerSessionKind,
  OpenbotComputerSetup,
  OpenbotComputerWindow,
  OpenbotComputerWindowId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

/**
 * The port every platform backend implements. Session policy (viewers, the
 * input lease, ordering, fanout) lives above this port and is platform
 * neutral; everything below it is translation into one platform's mechanics.
 *
 * Coordinates crossing this port are display pixels with the origin at the
 * top-left of the named display, exactly as the contract promises clients.
 * A backend converts to its own global space (points, screen offsets) inside.
 */

/** One encoded frame of one display. `jpeg` is a complete JPEG file. */
export interface ComputerFrame {
  readonly displayId: OpenbotComputerDisplayId;
  readonly jpeg: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly capturedAtMs: number;
}

/** How a capture should be encoded. The session layer computes the maximum
    over every viewer of a display and restarts the capture when it changes. */
export interface CaptureProfile {
  readonly maxWidthPx: number;
  readonly fps: number;
  /** 0.1 to 1. */
  readonly quality: number;
}

/** What the backend knows about the host before any display is touched. */
export interface ComputerBackendDescription {
  readonly session: OpenbotComputerSessionKind;
  readonly permissions: OpenbotComputerPermissions;
  /** Null when the platform needs no host setup. */
  readonly setup: OpenbotComputerSetup | null;
  readonly capabilities: OpenbotComputerCapabilities;
  /** A short reason the backend cannot work right now, or null. Shown to the
      user verbatim, so it names the fix. */
  readonly unavailableReason: string | null;
}

export interface ComputerBackendShape {
  readonly platform: "darwin" | "linux" | "unsupported";
  readonly describe: Effect.Effect<ComputerBackendDescription, OpenbotComputerError>;
  readonly listDisplays: Effect.Effect<ReadonlyArray<OpenbotComputerDisplay>, OpenbotComputerError>;
  readonly listWindows: Effect.Effect<ReadonlyArray<OpenbotComputerWindow>, OpenbotComputerError>;
  readonly focusWindow: (id: OpenbotComputerWindowId) => Effect.Effect<void, OpenbotComputerError>;
  readonly screenshot: (
    displayId: OpenbotComputerDisplayId,
    maxWidthPx: number,
  ) => Effect.Effect<ComputerFrame, OpenbotComputerError>;
  /**
   * Starts capturing one display for as long as the returned scope is open.
   * The stream ends when the display disappears or the capture fails; it
   * never buffers more than a couple of frames, so a slow consumer sees
   * fresh frames rather than a growing backlog.
   */
  readonly capture: (
    displayId: OpenbotComputerDisplayId,
    profile: CaptureProfile,
  ) => Effect.Effect<
    Stream.Stream<ComputerFrame, OpenbotComputerError>,
    OpenbotComputerError,
    Scope.Scope
  >;
  /**
   * Delivers events in order. A backend reports per-event rejections (unknown
   * key, point off the display) in the result instead of failing the batch,
   * so one bad event does not lose the ones behind it.
   *
   * Interruption is the cancel signal: when the effect is interrupted the
   * backend stops delivering promptly (a long `text` event stops mid-string)
   * and delivers nothing further from that batch. It does not release what
   * is held; the session follows with `release-all`, which a backend answers
   * by releasing every button, key, and modifier it currently holds down on
   * that display, whoever pressed them.
   */
  readonly input: (
    displayId: OpenbotComputerDisplayId,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) => Effect.Effect<OpenbotComputerInputResult, OpenbotComputerError>;
  readonly createDisplay: (
    input: OpenbotComputerDisplayCreateInput,
  ) => Effect.Effect<OpenbotComputerDisplay, OpenbotComputerError>;
  /** Only displays this backend created. Physical displays fail with
      `display_not_found`. */
  readonly destroyDisplay: (
    id: OpenbotComputerDisplayId,
  ) => Effect.Effect<void, OpenbotComputerError>;
  readonly launch: (
    input: OpenbotComputerLaunchInput,
  ) => Effect.Effect<OpenbotComputerLaunchResult, OpenbotComputerError>;
  /** Emits whenever displays, windows, or permissions may have changed. The
      session layer re-reads and republishes status; the payload is only a
      nudge. */
  readonly changes: Stream.Stream<void>;
}

export class ComputerBackend extends Context.Service<ComputerBackend, ComputerBackendShape>()(
  "t3/openbot/computer/ComputerBackend",
) {}
