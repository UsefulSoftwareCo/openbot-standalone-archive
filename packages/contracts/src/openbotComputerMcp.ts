import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OpenbotComputerAvailability,
  OpenbotComputerCapabilities,
  OpenbotComputerController,
  OpenbotComputerDisplay,
  OpenbotComputerDisplayId,
  OpenbotComputerHost,
  OpenbotComputerInputBatch,
  OpenbotComputerInputResult,
  OpenbotComputerPermissions,
  OpenbotComputerSessionKind,
  OpenbotComputerWindow,
  OpenbotComputerWindowId,
} from "./openbotComputer.ts";

/**
 * The agent-facing projection of the computer contract, used by the `t3-code`
 * MCP `computer_*` tools.
 *
 * These are deliberately not the wire schemas the client uses. A tool schema is
 * read by a model, so every field carries its own description, the status is
 * compacted to what a decision needs, and a screenshot names the scale factor
 * that maps its pixels back to display pixels. Everything an agent sends
 * (input batches above all) stays the wire schema, because agent input lands in
 * the same per-display queue as the human's.
 */

/** Longest edge a `computer_screenshot` defaults to. Big enough to read UI
    text, small enough that a full-resolution desktop does not dominate the
    context window. */
export const COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX = 1280;

/** Hard ceiling on a screenshot's width, whatever the display measures. */
export const COMPUTER_SCREENSHOT_MAX_WIDTH_PX = 1920;

/** Host setup, compacted to the two things an agent can say out loud: whether
    the computer is usable, and the exact commands that would fix it. */
export const ComputerSetupSummary = Schema.Struct({
  ready: Schema.Boolean,
  /** Names of the tools this host is missing. Empty when `ready`. */
  missing: Schema.Array(Schema.String),
  /** One shell command per missing tool, where one is known. */
  install: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
});
export type ComputerSetupSummary = typeof ComputerSetupSummary.Type;

/** Windows are omitted here on purpose: they change on every focus and belong
    to `computer_list_windows`, which the agent should call right before it
    acts on one. */
export const ComputerStatusResult = Schema.Struct({
  host: OpenbotComputerHost,
  session: OpenbotComputerSessionKind,
  availability: OpenbotComputerAvailability,
  /** Why the computer is not ready, or a warning while it is. */
  detail: Schema.NullOr(Schema.String),
  permissions: OpenbotComputerPermissions,
  setup: Schema.NullOr(ComputerSetupSummary),
  capabilities: OpenbotComputerCapabilities,
  displays: Schema.Array(OpenbotComputerDisplay),
  /** Who holds the single input lease right now. When a person holds it, agent
      input is rejected until they stop controlling. */
  controller: Schema.NullOr(OpenbotComputerController),
});
export type ComputerStatusResult = typeof ComputerStatusResult.Type;

export const ComputerScreenshotInput = Schema.Struct({
  displayId: Schema.optional(
    OpenbotComputerDisplayId.annotate({
      description: "Which display to capture. Defaults to the main display.",
    }),
  ),
  maxWidthPx: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 160, maximum: COMPUTER_SCREENSHOT_MAX_WIDTH_PX }),
    ).annotate({
      description: `Downscale the capture to this width before encoding. Defaults to ${COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX}. Pass the display's own width to read coordinates straight off the image.`,
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

export const ComputerListWindowsInput = Schema.Struct({
  displayId: Schema.optional(
    OpenbotComputerDisplayId.annotate({
      description: "Only list windows on this display. Defaults to every display.",
    }),
  ),
});
export type ComputerListWindowsInput = typeof ComputerListWindowsInput.Type;

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

/** An agent's batch is exactly the human's batch: one schema, one per-display
    queue, one ordering. */
export const ComputerInputInput = OpenbotComputerInputBatch;
export type ComputerInputInput = typeof ComputerInputInput.Type;

export const ComputerInputResult = OpenbotComputerInputResult;
export type ComputerInputResult = typeof ComputerInputResult.Type;

/**
 * One flat object rather than a create/destroy union, because a `Schema.Union`
 * serialises to `anyOf` and an MCP tool whose input schema is not an object
 * makes clients reject the whole server. `action` decides which of the other
 * fields are required; the server parses this into
 * `ComputerManageDisplayRequest` and refuses the mismatched combinations.
 */
export const ComputerManageDisplayInput = Schema.Struct({
  action: Schema.Literals(["create", "destroy"]).annotate({
    description:
      "'create' requires widthPx and heightPx; 'destroy' requires displayId of a managed display.",
  }),
  displayId: Schema.optional(
    OpenbotComputerDisplayId.annotate({
      description:
        "For 'destroy': a managed display created earlier. Physical displays cannot be destroyed.",
    }),
  ),
  name: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(64)).annotate({
      description: "For 'create': the label shown in the display picker.",
    }),
  ),
  widthPx: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 640, maximum: 7680 }))),
  heightPx: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 480, maximum: 4320 }))),
  hiDpi: Schema.optional(
    Schema.Boolean.annotate({
      description: "For 'create' on macOS: render at 2x. Ignored elsewhere.",
    }),
  ),
});
export type ComputerManageDisplayInput = typeof ComputerManageDisplayInput.Type;

/** What the flat tool input means once the action and its fields agree. */
export type ComputerManageDisplayRequest =
  | {
      readonly action: "create";
      readonly name?: string | undefined;
      readonly widthPx: number;
      readonly heightPx: number;
      readonly hiDpi?: boolean | undefined;
    }
  | { readonly action: "destroy"; readonly displayId: OpenbotComputerDisplayId };

export const ComputerManageDisplayResult = Schema.Struct({
  action: Schema.Literals(["create", "destroy"]),
  /** The display just created; null after a destroy. */
  display: Schema.NullOr(OpenbotComputerDisplay),
  /** Every display after the change, so the next call can target one without
      another round trip. */
  displays: Schema.Array(OpenbotComputerDisplay),
});
export type ComputerManageDisplayResult = typeof ComputerManageDisplayResult.Type;

export const ComputerLaunchInput = Schema.Struct({
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description:
      "An application name or bundle path on macOS ('Safari'), an executable on Linux ('xterm').",
  }),
  args: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(1024)))),
  displayId: Schema.optional(
    OpenbotComputerDisplayId.annotate({
      description: "Which display the new window should open on. Defaults to the main display.",
    }),
  ),
});
export type ComputerLaunchInput = typeof ComputerLaunchInput.Type;

export const ComputerLaunchResult = Schema.Struct({
  /** Null when the platform launched the app without reporting a process. */
  pid: Schema.NullOr(Schema.Int),
  /** The display the app was launched on, resolved from the input or the main
      display, so the next screenshot looks at the right screen. */
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
