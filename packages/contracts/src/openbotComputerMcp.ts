import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  MAX_COMPUTER_INPUT_BATCH,
  OpenbotChatComputerState,
  OpenbotComputerController,
  OpenbotComputerDisplay,
  OpenbotComputerDisplayId,
  OpenbotComputerInputEvent,
  OpenbotComputerInputResult,
  OpenbotComputerWindow,
  OpenbotComputerWindowId,
} from "./openbotComputer.ts";

/**
 * The agent-facing projection of the computer contract, used by the `t3-code`
 * MCP `computer_*` tools.
 *
 * Every tool here is scoped to the computer of the chat the calling thread
 * belongs to, so nothing an agent sends names a display: there is exactly one
 * screen it can reach, the chat owns it, and it is created on first use.
 *
 * These are deliberately not the wire schemas the client uses. A tool schema is
 * read by a model, so every field carries its own description, the status is
 * compacted to what a decision needs, and a screenshot names the scale factor
 * that maps its pixels back to display pixels.
 */

/**
 * The one limitation a model has to plan around, repeated wherever it decides
 * something: the chat's screen is a screen, not a sandbox.
 */
export const COMPUTER_SHARED_FOCUS_LIMITATION =
  "This chat's computer is its own screen, not its own machine. On macOS it shares one pointer, one keyboard, and one frontmost app with the person and with any other agent, so focus can move between your calls: check with computer_list_windows and computer_focus_window before you type.";

/** Longest edge a `computer_screenshot` defaults to. Big enough to read UI
    text, small enough that a full-resolution desktop does not dominate the
    context window. */
export const COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX = 1280;

/** Hard ceiling on a screenshot's width, whatever the display measures. */
export const COMPUTER_SCREENSHOT_MAX_WIDTH_PX = 1920;

/** The calling chat's computer, as the agent that works in that chat sees it. */
export const ComputerStatusResult = Schema.Struct({
  /** The chat this computer belongs to. A sub-chat reports its parent's, which
      is the screen it actually works on. */
  chat: Schema.String,
  state: OpenbotChatComputerState,
  /** The chat's screen, including the pixel size input coordinates are in.
      Null unless the state is `ready`. */
  display: Schema.NullOr(OpenbotComputerDisplay),
  /** Why the computer is unavailable, or a standing caveat while it is ready. */
  detail: Schema.NullOr(Schema.String),
  /** The windows on the chat's screen right now. */
  windows: Schema.Array(OpenbotComputerWindow),
  /** Who holds the single input lease right now. When a person holds it, agent
      input is rejected until they stop controlling. */
  controller: Schema.NullOr(OpenbotComputerController),
  /** Whether `computer_launch` can work right now. False on macOS until the
      person grants Accessibility; `detail` says so. */
  canLaunch: Schema.Boolean,
  /** Always `COMPUTER_SHARED_FOCUS_LIMITATION`, so the constraint is in front
      of the model at the moment it plans. */
  sharing: Schema.String,
});
export type ComputerStatusResult = typeof ComputerStatusResult.Type;

export const ComputerScreenshotInput = Schema.Struct({
  maxWidthPx: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 160, maximum: COMPUTER_SCREENSHOT_MAX_WIDTH_PX }),
    ).annotate({
      description: `Downscale the capture to this width before encoding. Defaults to ${COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX}. Pass the screen's own width, from computer_status, to read coordinates straight off the image.`,
    }),
  ),
});
export type ComputerScreenshotInput = typeof ComputerScreenshotInput.Type;

export const ComputerScreenshotImage = Schema.Struct({
  mimeType: Schema.Literal("image/jpeg"),
  /** Base64 JPEG. The same bytes are attached to the tool result as an image
      block, so a model that can see images should read those instead. */
  data: Schema.String,
  widthPx: Schema.Int,
  heightPx: Schema.Int,
});
export type ComputerScreenshotImage = typeof ComputerScreenshotImage.Type;

export const ComputerScreenshotResult = Schema.Struct({
  image: ComputerScreenshotImage,
  displayId: OpenbotComputerDisplayId,
  /**
   * `display width in pixels / image width in pixels`. Input coordinates are
   * display pixels, so multiply a point measured on this image by `scale` to
   * get the point to send to `computer_input`. It is 1 when the capture was
   * not downscaled.
   */
  scale: Schema.Number,
  capturedAt: IsoDateTime,
  /** Set when the capture may not show what the user expects, most often a
      macOS Screen Recording permission that was never granted. */
  caveat: Schema.NullOr(Schema.String),
});
export type ComputerScreenshotResult = typeof ComputerScreenshotResult.Type;

export const ComputerListWindowsResult = Schema.Struct({
  windows: Schema.Array(OpenbotComputerWindow),
});
export type ComputerListWindowsResult = typeof ComputerListWindowsResult.Type;

export const ComputerFocusWindowInput = Schema.Struct({
  windowId: OpenbotComputerWindowId.annotate({
    description: "A window id from computer_list_windows.",
  }),
});
export type ComputerFocusWindowInput = typeof ComputerFocusWindowInput.Type;

/** The events are exactly the human's events, and they land in the same
    per-display queue under the same lease; only the target is implied rather
    than named. */
export const ComputerInputInput = Schema.Struct({
  events: Schema.Array(OpenbotComputerInputEvent).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_COMPUTER_INPUT_BATCH),
  ),
});
export type ComputerInputInput = typeof ComputerInputInput.Type;

export const ComputerInputResult = OpenbotComputerInputResult;
export type ComputerInputResult = typeof ComputerInputResult.Type;

export const ComputerLaunchInput = Schema.Struct({
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description:
      "An application name or bundle path on macOS ('Safari'), an executable on Linux ('xterm').",
  }),
  args: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(1024)))),
});
export type ComputerLaunchInput = typeof ComputerLaunchInput.Type;

export const ComputerLaunchResult = Schema.Struct({
  /** Null when the platform launched the app without reporting a process. */
  pid: Schema.NullOr(Schema.Int),
  /** The chat's screen the app was launched onto. */
  displayId: OpenbotComputerDisplayId,
});
export type ComputerLaunchResult = typeof ComputerLaunchResult.Type;

/**
 * What a `computer_*` tool returns instead of succeeding.
 *
 * The codes mirror `OpenbotComputerError` so a failure keeps its meaning across
 * the MCP boundary, and `failureMode: "return"` hands it to the model as a
 * result it can read. `not_controlling` in particular is not a retry: a person
 * has taken the shared desktop, and the agent should say so rather than fight
 * them for the pointer.
 */
export class OpenbotComputerMcpFailure extends Schema.TaggedErrorClass<OpenbotComputerMcpFailure>()(
  "OpenbotComputerMcpFailure",
  {
    code: Schema.Literals([
      "unsupported",
      "capture_failed",
      "permission_denied",
      "display_not_found",
      "window_not_found",
      "not_controlling",
      "setup_required",
      "backend_unavailable",
      "invalid_input",
    ]),
    message: Schema.String,
  },
) {}
