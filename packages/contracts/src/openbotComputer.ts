import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformOs } from "./environment.ts";
import { OpenbotChannelId } from "./openbot.ts";

/**
 * The computer an environment's agents act on, as a human sees and controls it.
 *
 * The computer is the host's shared desktop session. One login session has one
 * pointer, one key window, and one frontmost app, so a human viewer and the
 * agents always share it. A managed display (a macOS virtual display or a
 * headless X server on Linux) is another screen on that same session or a
 * separate headless desktop, never an isolated concurrent desktop per agent.
 * The contract names that reality rather than implying more.
 */

/** A backend-stable handle for one screen. On macOS it is the CoreGraphics
    display id; on Linux it names the X display (and screen) being captured.
    Never an ordinal: a handle that survives a display list refresh is what
    lets a viewer keep pointing at the same screen. */
export const OpenbotComputerDisplayId = TrimmedNonEmptyString.pipe(
  Schema.brand("OpenbotComputerDisplayId"),
);
export type OpenbotComputerDisplayId = typeof OpenbotComputerDisplayId.Type;

/** A backend-stable handle for one window, valid until that window closes. */
export const OpenbotComputerWindowId = TrimmedNonEmptyString.pipe(
  Schema.brand("OpenbotComputerWindowId"),
);
export type OpenbotComputerWindowId = typeof OpenbotComputerWindowId.Type;

/** Why a host can or cannot be previewed. `unsupported` is a property of the
    platform, `unavailable` of this particular host (missing tool, denied
    permission). `ready` is only ever claimed after a capture has actually
    succeeded on this server, so a host that has never been asked is `unknown`
    rather than optimistically ready. */
export const OpenbotComputerAvailability = Schema.Literals([
  "ready",
  "unknown",
  "unsupported",
  "unavailable",
]);
export type OpenbotComputerAvailability = typeof OpenbotComputerAvailability.Type;

/** What kind of desktop the server is attached to.
    - `signed-in-desktop`: the macOS login session of the user who started the server.
    - `shared-x11-desktop`: an existing X11 session reachable through `DISPLAY`.
    - `managed-x11-session`: a headless X server this server started and owns.
    - `unsupported`: no desktop this server knows how to capture or drive. */
export const OpenbotComputerSessionKind = Schema.Literals([
  "signed-in-desktop",
  "shared-x11-desktop",
  "managed-x11-session",
  "unsupported",
]);
export type OpenbotComputerSessionKind = typeof OpenbotComputerSessionKind.Type;

export const OpenbotComputerDisplayKind = Schema.Literals([
  "physical",
  "managed-virtual",
  "managed-x11",
]);
export type OpenbotComputerDisplayKind = typeof OpenbotComputerDisplayKind.Type;

export const OpenbotComputerDisplay = Schema.Struct({
  id: OpenbotComputerDisplayId,
  name: Schema.String,
  kind: OpenbotComputerDisplayKind,
  /** Pixel dimensions of the capture surface. Input coordinates are expressed
      in this space. */
  widthPx: Schema.Int,
  heightPx: Schema.Int,
  /** Pixels per point. 2 on a Retina display, 1 on Linux. */
  scale: Schema.Number,
  main: Schema.Boolean,
  /** True when this server created the display and owns its lifetime. */
  managed: Schema.Boolean,
});
export type OpenbotComputerDisplay = typeof OpenbotComputerDisplay.Type;

export const OpenbotComputerWindow = Schema.Struct({
  id: OpenbotComputerWindowId,
  /** Null when the window is off every known display or the backend cannot
      attribute it. */
  displayId: Schema.NullOr(OpenbotComputerDisplayId),
  title: Schema.String,
  /** Owning application name, as the platform reports it. */
  app: Schema.String,
  pid: Schema.NullOr(Schema.Int),
  /** Frame in the pixel space of `displayId`, origin at that display's top-left. */
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  focused: Schema.Boolean,
  minimized: Schema.Boolean,
});
export type OpenbotComputerWindow = typeof OpenbotComputerWindow.Type;

/** `not-applicable` is for platforms with no such gate (Linux X11 has no
    capture or accessibility permission). `unknown` means the backend could
    not ask. */
export const OpenbotComputerPermissionState = Schema.Literals([
  "granted",
  "denied",
  "unknown",
  "not-applicable",
]);
export type OpenbotComputerPermissionState = typeof OpenbotComputerPermissionState.Type;

/** Screen capture and input injection are separate grants on macOS and are
    reported separately so the UI can say which one is missing. */
export const OpenbotComputerPermissions = Schema.Struct({
  screenCapture: OpenbotComputerPermissionState,
  accessibility: OpenbotComputerPermissionState,
  /** How to fix a denial, in the platform's own words. Null when nothing is
      missing. */
  detail: Schema.NullOr(Schema.String),
});
export type OpenbotComputerPermissions = typeof OpenbotComputerPermissions.Type;

export const OpenbotComputerDependency = Schema.Struct({
  name: Schema.String,
  present: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  /** One shell command that installs it on this host, or null when the
      package manager could not be identified. */
  install: Schema.NullOr(Schema.String),
});
export type OpenbotComputerDependency = typeof OpenbotComputerDependency.Type;

/** Host setup the backend needs before it can work, so a missing tool is an
    actionable list rather than a stub that pretends. */
export const OpenbotComputerSetup = Schema.Struct({
  ready: Schema.Boolean,
  dependencies: Schema.Array(OpenbotComputerDependency),
  notes: Schema.Array(Schema.String),
});
export type OpenbotComputerSetup = typeof OpenbotComputerSetup.Type;

/** What this backend can do at all, independent of current permission state. */
export const OpenbotComputerCapabilities = Schema.Struct({
  stream: Schema.Boolean,
  input: Schema.Boolean,
  windows: Schema.Boolean,
  focusWindow: Schema.Boolean,
  managedDisplays: Schema.Boolean,
  launchApp: Schema.Boolean,
});
export type OpenbotComputerCapabilities = typeof OpenbotComputerCapabilities.Type;

export const NO_COMPUTER_CAPABILITIES: OpenbotComputerCapabilities = {
  stream: false,
  input: false,
  windows: false,
  focusWindow: false,
  managedDisplays: false,
  launchApp: false,
};

export const OpenbotComputerHost = Schema.Struct({
  label: Schema.String,
  platform: ExecutionEnvironmentPlatformOs,
});
export type OpenbotComputerHost = typeof OpenbotComputerHost.Type;

/** Who currently holds the single input lease. A `viewer` is a human at a
    client; an `agent` is a thread's tool call. Null when nobody is
    controlling and any authorized input is accepted. */
export const OpenbotComputerController = Schema.Struct({
  kind: Schema.Literals(["viewer", "agent"]),
  label: Schema.String,
  since: IsoDateTime,
});
export type OpenbotComputerController = typeof OpenbotComputerController.Type;

export const OpenbotComputerStatus = Schema.Struct({
  host: OpenbotComputerHost,
  session: OpenbotComputerSessionKind,
  availability: OpenbotComputerAvailability,
  /** Why the host is not `ready`, or a warning while it is. Null when there is
      nothing worth saying. */
  detail: Schema.NullOr(Schema.String),
  permissions: OpenbotComputerPermissions,
  /** Null when the platform needs no host setup. */
  setup: Schema.NullOr(OpenbotComputerSetup),
  capabilities: OpenbotComputerCapabilities,
  displays: Schema.Array(OpenbotComputerDisplay),
  /** Empty when `capabilities.windows` is false or the list could not be read. */
  windows: Schema.Array(OpenbotComputerWindow),
  controller: Schema.NullOr(OpenbotComputerController),
  /** When this server last captured a frame successfully, null if never.
      This is the evidence behind `ready`. */
  lastCaptureAt: Schema.NullOr(IsoDateTime),
  /** The raw failure text of the last capture attempt, null when the last
      attempt succeeded or none was made. `detail` is the human reading of it. */
  lastError: Schema.NullOr(Schema.String),
  checkedAt: IsoDateTime,
});
export type OpenbotComputerStatus = typeof OpenbotComputerStatus.Type;

export const OpenbotComputerSnapshotInput = Schema.Struct({
  /** Longest edge the server should downscale to before encoding. */
  maxWidthPx: Schema.optional(Schema.Int),
  /** Defaults to the main display. */
  displayId: Schema.optional(OpenbotComputerDisplayId),
});
export type OpenbotComputerSnapshotInput = typeof OpenbotComputerSnapshotInput.Type;

export const OpenbotComputerSnapshot = Schema.Struct({
  mimeType: Schema.Literal("image/jpeg"),
  dataBase64: Schema.String,
  /** Absent when the encoded image's header could not be read. */
  widthPx: Schema.optional(Schema.Int),
  heightPx: Schema.optional(Schema.Int),
  displayId: Schema.optional(OpenbotComputerDisplayId),
  capturedAt: IsoDateTime,
  /** Set when the capture looks like it may not show what the user expects,
      most importantly a macOS Screen Recording permission that was never
      granted. Null when the capture looks normal. */
  caveat: Schema.NullOr(Schema.String),
});
export type OpenbotComputerSnapshot = typeof OpenbotComputerSnapshot.Type;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const OpenbotComputerModifier = Schema.Literals(["shift", "control", "alt", "meta"]);
export type OpenbotComputerModifier = typeof OpenbotComputerModifier.Type;

export const OpenbotComputerMouseButton = Schema.Literals(["left", "right", "middle"]);
export type OpenbotComputerMouseButton = typeof OpenbotComputerMouseButton.Type;

/** A point in the target display's pixel space, origin top-left. */
export const OpenbotComputerPoint = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type OpenbotComputerPoint = typeof OpenbotComputerPoint.Type;

/** A physical key named by its W3C `KeyboardEvent.code` value ("KeyA",
    "Digit1", "Enter", "ArrowLeft", "F5", "MetaLeft"). Codes name positions,
    not characters, so they are the same on every keyboard layout; characters
    travel as `text` events instead. */
export const OpenbotComputerKey = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
export type OpenbotComputerKey = typeof OpenbotComputerKey.Type;

const Modifiers = Schema.optional(Schema.Array(OpenbotComputerModifier));

export const OpenbotComputerMoveEvent = Schema.Struct({
  type: Schema.Literal("move"),
  point: OpenbotComputerPoint,
});
export const OpenbotComputerButtonEvent = Schema.Struct({
  type: Schema.Literal("button"),
  button: OpenbotComputerMouseButton,
  action: Schema.Literals(["down", "up"]),
  point: OpenbotComputerPoint,
});
export const OpenbotComputerClickEvent = Schema.Struct({
  type: Schema.Literal("click"),
  button: OpenbotComputerMouseButton,
  /** 1 for a click, 2 for a double-click, 3 for a triple-click. */
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  point: OpenbotComputerPoint,
  modifiers: Modifiers,
});
/** Wheel motion in pixels using the browser's sign convention: a positive
    `deltaY` scrolls the content up (the page moves toward its end). */
export const OpenbotComputerScrollEvent = Schema.Struct({
  type: Schema.Literal("scroll"),
  point: OpenbotComputerPoint,
  deltaX: Schema.Number,
  deltaY: Schema.Number,
});
export const OpenbotComputerKeyEvent = Schema.Struct({
  type: Schema.Literal("key"),
  key: OpenbotComputerKey,
  action: Schema.Literals(["down", "up"]),
  modifiers: Modifiers,
});
/** A down followed by an up. */
export const OpenbotComputerKeyPressEvent = Schema.Struct({
  type: Schema.Literal("key-press"),
  key: OpenbotComputerKey,
  modifiers: Modifiers,
});
/** Layout-independent text entry. */
export const OpenbotComputerTextEvent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
/** Release every button and key this source is holding. Sent by clients on
    blur and by the server when a controller disconnects, so nothing stays
    stuck down on the shared desktop. */
export const OpenbotComputerReleaseAllEvent = Schema.Struct({
  type: Schema.Literal("release-all"),
});

export const OpenbotComputerInputEvent = Schema.Union([
  OpenbotComputerMoveEvent,
  OpenbotComputerButtonEvent,
  OpenbotComputerClickEvent,
  OpenbotComputerScrollEvent,
  OpenbotComputerKeyEvent,
  OpenbotComputerKeyPressEvent,
  OpenbotComputerTextEvent,
  OpenbotComputerReleaseAllEvent,
]);
export type OpenbotComputerInputEvent = typeof OpenbotComputerInputEvent.Type;

export const MAX_COMPUTER_INPUT_BATCH = 64;

export const OpenbotComputerInputBatch = Schema.Struct({
  displayId: OpenbotComputerDisplayId,
  events: Schema.Array(OpenbotComputerInputEvent).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_COMPUTER_INPUT_BATCH),
  ),
});
export type OpenbotComputerInputBatch = typeof OpenbotComputerInputBatch.Type;

export const OpenbotComputerInputRejection = Schema.Struct({
  index: Schema.Int,
  reason: Schema.String,
});
export type OpenbotComputerInputRejection = typeof OpenbotComputerInputRejection.Type;

export const OpenbotComputerInputResult = Schema.Struct({
  delivered: Schema.Int,
  rejected: Schema.Array(OpenbotComputerInputRejection),
});
export type OpenbotComputerInputResult = typeof OpenbotComputerInputResult.Type;

// ---------------------------------------------------------------------------
// Control and management
// ---------------------------------------------------------------------------

export const OpenbotComputerControlInput = Schema.Struct({
  action: Schema.Literals(["take", "release"]),
});
export type OpenbotComputerControlInput = typeof OpenbotComputerControlInput.Type;

export const OpenbotComputerWindowsListInput = Schema.Struct({
  displayId: Schema.optional(OpenbotComputerDisplayId),
});
export type OpenbotComputerWindowsListInput = typeof OpenbotComputerWindowsListInput.Type;

export const OpenbotComputerWindowsListResult = Schema.Struct({
  windows: Schema.Array(OpenbotComputerWindow),
});
export type OpenbotComputerWindowsListResult = typeof OpenbotComputerWindowsListResult.Type;

export const OpenbotComputerWindowFocusInput = Schema.Struct({
  windowId: OpenbotComputerWindowId,
});
export type OpenbotComputerWindowFocusInput = typeof OpenbotComputerWindowFocusInput.Type;

export const OpenbotComputerDisplayCreateInput = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  widthPx: Schema.Int.check(Schema.isBetween({ minimum: 640, maximum: 7680 })),
  heightPx: Schema.Int.check(Schema.isBetween({ minimum: 480, maximum: 4320 })),
  /** macOS only: render at 2x. Ignored elsewhere. */
  hiDpi: Schema.optional(Schema.Boolean),
});
export type OpenbotComputerDisplayCreateInput = typeof OpenbotComputerDisplayCreateInput.Type;

export const OpenbotComputerDisplayDestroyInput = Schema.Struct({
  displayId: OpenbotComputerDisplayId,
});
export type OpenbotComputerDisplayDestroyInput = typeof OpenbotComputerDisplayDestroyInput.Type;

export const OpenbotComputerLaunchInput = Schema.Struct({
  /** An application name or bundle path on macOS; an executable on Linux. */
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  args: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(1024)))),
  /** Which display the new window should land on. Defaults to the main display. */
  displayId: Schema.optional(OpenbotComputerDisplayId),
});
export type OpenbotComputerLaunchInput = typeof OpenbotComputerLaunchInput.Type;

export const OpenbotComputerLaunchResult = Schema.Struct({
  pid: Schema.NullOr(Schema.Int),
});
export type OpenbotComputerLaunchResult = typeof OpenbotComputerLaunchResult.Type;

export class OpenbotComputerError extends Schema.TaggedErrorClass<OpenbotComputerError>()(
  "OpenbotComputerError",
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

// ---------------------------------------------------------------------------
// Live stream socket (GET /ws/openbot-computer)
// ---------------------------------------------------------------------------

/** Path of the authenticated frame socket. Under the `/ws` prefix so every
    dev proxy and relay that carries the RPC socket carries this one too. */
export const OPENBOT_COMPUTER_STREAM_PATH = "/ws/openbot-computer";

export const OpenbotComputerStreamProfile = Schema.Struct({
  maxWidthPx: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 })),
  fps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
  quality: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 1 }))),
});
export type OpenbotComputerStreamProfile = typeof OpenbotComputerStreamProfile.Type;

/** Text frames from the viewer. Binary frames are never sent upstream. */
export const OpenbotComputerStreamClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("open"),
    displayId: OpenbotComputerDisplayId,
    ...OpenbotComputerStreamProfile.fields,
    /** Ask for the input lease on open. */
    control: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("input"),
    seq: Schema.Int,
    events: Schema.Array(OpenbotComputerInputEvent).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_COMPUTER_INPUT_BATCH),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("control"), action: Schema.Literals(["take", "release"]) }),
  Schema.Struct({ type: Schema.Literal("ping"), t: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("close") }),
]);
export type OpenbotComputerStreamClientMessage = typeof OpenbotComputerStreamClientMessage.Type;

export const OpenbotComputerStreamState = Schema.Literals([
  "capturing",
  "idle",
  "superseded",
  "display-gone",
  "permission-denied",
  "error",
  "closing",
]);
export type OpenbotComputerStreamState = typeof OpenbotComputerStreamState.Type;

/** Text frames to the viewer. Each binary frame is one complete JPEG of the
    display named in the last `hello` or `geometry`. */
export const OpenbotComputerStreamServerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"),
    viewerId: Schema.String,
    display: OpenbotComputerDisplay,
    frameWidthPx: Schema.Int,
    frameHeightPx: Schema.Int,
    fps: Schema.Int,
    encoding: Schema.Literal("image/jpeg"),
    controller: Schema.NullOr(OpenbotComputerController),
    /** Whether this viewer holds the lease. */
    controlling: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("geometry"),
    display: OpenbotComputerDisplay,
    frameWidthPx: Schema.Int,
    frameHeightPx: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("controller"),
    controller: Schema.NullOr(OpenbotComputerController),
    controlling: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("input-ack"),
    seq: Schema.Int,
    result: OpenbotComputerInputResult,
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    state: OpenbotComputerStreamState,
    message: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("pong"), t: Schema.Number }),
]);
export type OpenbotComputerStreamServerMessage = typeof OpenbotComputerStreamServerMessage.Type;

// ---------------------------------------------------------------------------
// The chat's computer
// ---------------------------------------------------------------------------

/**
 * Every top-level chat owns one managed display, provisioned the first time
 * something asks for it and reused for as long as the server runs. A child
 * chat has no display of its own: it works on its parent's. The chat id is the
 * stable name; the display id underneath is whatever the host handed out this
 * process and is never persisted or shown as identity.
 *
 * On macOS that display is another screen on the one signed-in session, which
 * still has a single pointer, keyboard, and frontmost app. On Linux it is a
 * headless X session of its own. Neither is a sandbox.
 */
export const OpenbotChatComputerState = Schema.Literals([
  /** Nothing has asked for this chat's display yet; nothing is captured. */
  "idle",
  /** The host is creating it. */
  "provisioning",
  /** The display exists and can be viewed and driven. */
  "ready",
  /** The host cannot provide one right now; `detail` says why. */
  "unavailable",
]);
export type OpenbotChatComputerState = typeof OpenbotChatComputerState.Type;

export const OpenbotChatComputer = Schema.Struct({
  /** The chat whose computer this is: the top-level chat, even when asked
      through one of its children. */
  channelId: OpenbotChannelId,
  channelName: Schema.String,
  state: OpenbotChatComputerState,
  /** Present only while `ready`. */
  display: Schema.NullOr(OpenbotComputerDisplay),
  /** Why the computer is unavailable, or a standing caveat while it is ready. */
  detail: Schema.NullOr(Schema.String),
  /** Windows the host attributes to this chat's display. Empty when the
      backend cannot list windows. */
  windows: Schema.Array(OpenbotComputerWindow),
  controller: Schema.NullOr(OpenbotComputerController),
  /** Whether launching an app onto this display can work right now (macOS
      needs Accessibility to place the window; without it launch is refused
      rather than landing on the user's own screen). */
  canLaunch: Schema.Boolean,
  checkedAt: IsoDateTime,
});
export type OpenbotChatComputer = typeof OpenbotChatComputer.Type;

export const OpenbotChatComputerInput = Schema.Struct({
  channelId: OpenbotChannelId,
});
export type OpenbotChatComputerInput = typeof OpenbotChatComputerInput.Type;

/** Provision the chat's display if it does not exist yet, then describe it. */
export const OpenbotChatComputerEnsureInput = OpenbotChatComputerInput;

export const OpenbotChatComputerSnapshotInput = Schema.Struct({
  channelId: OpenbotChannelId,
  maxWidthPx: Schema.optional(Schema.Int),
});
export type OpenbotChatComputerSnapshotInput = typeof OpenbotChatComputerSnapshotInput.Type;

export const OpenbotChatComputerWindowFocusInput = Schema.Struct({
  channelId: OpenbotChannelId,
  windowId: OpenbotComputerWindowId,
});
export type OpenbotChatComputerWindowFocusInput = typeof OpenbotChatComputerWindowFocusInput.Type;

export const OpenbotChatComputerLaunchInput = Schema.Struct({
  channelId: OpenbotChannelId,
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  args: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(1024)))),
});
export type OpenbotChatComputerLaunchInput = typeof OpenbotChatComputerLaunchInput.Type;

export const OpenbotChatComputerInputBatch = Schema.Struct({
  channelId: OpenbotChannelId,
  events: Schema.Array(OpenbotComputerInputEvent).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_COMPUTER_INPUT_BATCH),
  ),
});
export type OpenbotChatComputerInputBatch = typeof OpenbotChatComputerInputBatch.Type;
