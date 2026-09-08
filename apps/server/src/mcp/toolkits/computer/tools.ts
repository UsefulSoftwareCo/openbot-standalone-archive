import {
  ComputerFocusWindowInput,
  ComputerInputInput,
  ComputerInputResult,
  ComputerLaunchInput,
  ComputerLaunchResult,
  ComputerListWindowsInput,
  ComputerListWindowsResult,
  ComputerManageDisplayInput,
  ComputerManageDisplayResult,
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
 * Descriptions here carry the two facts a model cannot infer from a schema:
 * the desktop is shared with a real person, and image pixels are not display
 * pixels. Both are load-bearing — the first decides what to do when input is
 * refused, the second decides where a click lands.
 */
const SHARED_DESKTOP =
  "This is the host's shared desktop: one pointer, one keyboard, one frontmost app, used at the same time by the person watching and by any other agent.";

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

export const ComputerStatusTool = readonlyComputerTool(
  Tool.make("computer_status", {
    description: `Report the state of this environment's computer. ${SHARED_DESKTOP} Returns the session kind, whether it is usable, macOS Screen Recording and Accessibility permissions, missing host setup with install commands, the displays and their pixel sizes, what the backend can do, and who holds control right now. Call this first: it tells you which displayId to pass to the other computer tools, and whether a person is currently controlling.`,
    success: ComputerStatusResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Get computer status")
    .annotate(Tool.Idempotent, true),
);

export const ComputerScreenshotTool = readonlyComputerTool(
  Tool.make("computer_screenshot", {
    description: `Capture one display of the shared desktop as a JPEG. Take one before you act and again after anything that should have changed the screen; the person and other agents move things between your calls. The image is downscaled to maxWidthPx (1280 by default), so its pixels are not display pixels: multiply any point you measure on the image by the returned scale to get the display pixels that computer_input expects. scale is 1 only when maxWidthPx is at least the display's own width.`,
    parameters: ComputerScreenshotInput,
    success: ComputerScreenshotResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Screenshot the computer")
    .annotate(Tool.Idempotent, true),
);

export const ComputerListWindowsTool = readonlyComputerTool(
  Tool.make("computer_list_windows", {
    description: `List the windows on the shared desktop: application, title, owning process, frame in display pixels, which display they are on, and which one is focused. Prefer this together with computer_focus_window over clicking at a position you remember from an earlier screenshot.`,
    parameters: ComputerListWindowsInput,
    success: ComputerListWindowsResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "List computer windows")
    .annotate(Tool.Idempotent, true),
);

export const ComputerFocusWindowTool = actingComputerTool(
  Tool.make("computer_focus_window", {
    description: `Raise one window and activate its application, then return the window list as it stands afterwards so you can confirm the focus landed. Do this before typing: the shared desktop has a single frontmost app and keystrokes go wherever focus is, including into the person's own window if you skip this.`,
    parameters: ComputerFocusWindowInput,
    success: ComputerListWindowsResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Title, "Focus a computer window"),
);

export const ComputerInputTool = actingComputerTool(
  Tool.make("computer_input", {
    description: `Send an ordered batch of pointer and keyboard events to one display of the shared desktop. Points are that display's pixels with the origin at its top-left, so take a computer_screenshot first and convert with its scale. Use text events to type characters, and key or key-press events with W3C key codes (KeyA, Digit1, Enter, ArrowLeft, MetaLeft) for shortcuts. If a person has taken control, the batch fails with not_controlling: that is not a retry, tell the person what you were about to do and stop.`,
    parameters: ComputerInputInput,
    success: ComputerInputResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Title, "Send computer input"),
);

export const ComputerManageDisplayTool = actingComputerTool(
  Tool.make("computer_manage_display", {
    description: `Create or destroy a managed display: an extra virtual screen on macOS, or a headless X screen on Linux. A managed display is another screen of the same shared desktop session, not a private desktop of your own — the person can look at it, and it disappears when the server stops. Destroy the displays you create when you are done with them.`,
    parameters: ComputerManageDisplayInput,
    success: ComputerManageDisplayResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Title, "Create or destroy a display"),
);

export const ComputerLaunchTool = actingComputerTool(
  Tool.make("computer_launch", {
    description: `Start an application on the shared desktop, optionally on a specific display. On a Linux managed X session this is how an application gets onto that session at all. The window appears on a screen the person can see, so say what you are opening and why.`,
    parameters: ComputerLaunchInput,
    success: ComputerLaunchResult,
    failure: OpenbotComputerMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Title, "Launch an app on the computer"),
);

export const ComputerToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerScreenshotTool,
  ComputerListWindowsTool,
  ComputerFocusWindowTool,
  ComputerInputTool,
  ComputerManageDisplayTool,
  ComputerLaunchTool,
);

/** `computer_screenshot` is registered by hand so its JPEG can leave as an MCP
    image content block; the rest register through the toolkit. */
export const ComputerStandardToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerListWindowsTool,
  ComputerFocusWindowTool,
  ComputerInputTool,
  ComputerManageDisplayTool,
  ComputerLaunchTool,
);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
