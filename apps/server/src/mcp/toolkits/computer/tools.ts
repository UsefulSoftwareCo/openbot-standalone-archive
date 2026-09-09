import {
  COMPUTER_SHARED_FOCUS_LIMITATION,
  ComputerFocusWindowInput,
  ComputerInputInput,
  ComputerInputResult,
  ComputerLaunchInput,
  ComputerLaunchResult,
  ComputerListWindowsResult,
  ComputerScreenshotInput,
  ComputerScreenshotResult,
  ComputerStatusResult,
  OpenbotComputerMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ComputerMcpService } from "./ComputerMcpService.ts";

const dependencies = [McpInvocationContext, ComputerMcpService];

/**
 * Descriptions here carry the three facts a model cannot infer from a schema:
 * the computer belongs to this chat and there is no other one to name, the
 * screen is still shared with a real person, and image pixels are not display
 * pixels. The first removes a whole class of wrong target, the second decides
 * what to do when input is refused, the third decides where a click lands.
 */
const CHAT_COMPUTER = `Every computer tool acts on this chat's own computer: one screen the chat owns, created the first time it is asked for. There is no other display to choose, and a sub-chat works on its parent's screen. ${COMPUTER_SHARED_FOCUS_LIMITATION}`;

/** Observes the desktop without changing it. */
const readonlyComputerTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false) as T;

/** Acts on the desktop. Not destructive in the MCP sense — nothing is deleted —
    but never repeatable, because the desktop moves under it. */
const actingComputerTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false) as T;

/**
 * Not annotated readonly: the first call is what brings this chat's screen into
 * existence. It is idempotent — every later call describes the same screen.
 */
export const ComputerStatusTool = Tool.make("computer_status", {
  description: `Report the state of this chat's computer, creating its screen if this is the first thing to ask for it. ${CHAT_COMPUTER} Returns the chat's name, whether the screen is ready, its pixel size, the windows on it, whether an app can be launched onto it, and who holds control right now. Call this first: it is what tells you the coordinate space the other tools work in, and whether a person is currently controlling.`,
  success: ComputerStatusResult,
  failure: OpenbotComputerMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get this chat's computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerScreenshotTool = readonlyComputerTool(
  Tool.make("computer_screenshot", {
    description: `Capture this chat's computer as a JPEG. Take one before you act and again after anything that should have changed the screen; the person and other agents move things between your calls. The image is downscaled to maxWidthPx (1280 by default), so its pixels are not display pixels: multiply any point you measure on the image by the returned scale to get the display pixels that computer_input expects. scale is 1 only when maxWidthPx is at least the screen's own width.`,
    parameters: ComputerScreenshotInput,
    success: ComputerScreenshotResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Screenshot this chat's computer")
    .annotate(Tool.Idempotent, true),
);

/** Takes no parameters at all: a thread has exactly one computer, its chat's.
    An empty `Schema.Struct({})` would serialise to a non-object input schema,
    which MCP clients reject for the whole server. */
export const ComputerListWindowsTool = readonlyComputerTool(
  Tool.make("computer_list_windows", {
    description: `List the windows on this chat's computer: application, title, owning process, frame in display pixels, and which one is focused. Windows on any other screen are not listed and cannot be acted on. Prefer this together with computer_focus_window over clicking at a position you remember from an earlier screenshot.`,
    success: ComputerListWindowsResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "List this chat's windows")
    .annotate(Tool.Idempotent, true),
);

export const ComputerFocusWindowTool = actingComputerTool(
  Tool.make("computer_focus_window", {
    description: `Raise one of this chat's windows and activate its application, then return the window list as it stands afterwards so you can confirm the focus landed. Do this before typing: on macOS the frontmost app is shared with the person, and keystrokes go wherever focus is, including into their own window if you skip this. A window that is not on this chat's screen comes back as window_not_found.`,
    parameters: ComputerFocusWindowInput,
    success: ComputerListWindowsResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Title, "Focus a window on this chat's computer"),
);

export const ComputerInputTool = actingComputerTool(
  Tool.make("computer_input", {
    description: `Send an ordered batch of pointer and keyboard events to this chat's computer. Points are that screen's pixels with the origin at its top-left, so take a computer_screenshot first and convert with its scale. Use text events to type characters, and key or key-press events with W3C key codes (KeyA, Digit1, Enter, ArrowLeft, MetaLeft) for shortcuts. If a person has taken control, the batch fails with not_controlling: that is not a retry, tell the person what you were about to do and stop.`,
    parameters: ComputerInputInput,
    success: ComputerInputResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Title, "Send input to this chat's computer"),
);

export const ComputerLaunchTool = actingComputerTool(
  Tool.make("computer_launch", {
    description: `Start an application on this chat's computer. The window opens on the chat's own screen, which the person can watch, so say what you are opening and why. When the host cannot place a window there — on macOS, until the person grants Accessibility — this fails with permission_denied and nothing is launched, rather than opening the app on the person's own screen. computer_status reports that ahead of time as canLaunch.`,
    parameters: ComputerLaunchInput,
    success: ComputerLaunchResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Title, "Launch an app on this chat's computer"),
);

export const ComputerToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerScreenshotTool,
  ComputerListWindowsTool,
  ComputerFocusWindowTool,
  ComputerInputTool,
  ComputerLaunchTool,
);

/** `computer_screenshot` is registered by hand so its JPEG can leave as an MCP
    image content block; the rest register through the toolkit. */
export const ComputerStandardToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerListWindowsTool,
  ComputerFocusWindowTool,
  ComputerInputTool,
  ComputerLaunchTool,
);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
