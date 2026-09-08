import { withComputerAccess } from "./ComputerMcpService.ts";
import { ComputerScreenshotToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

/**
 * Every computer tool is one gated service call. `withComputerAccess` owns both
 * the capability check and the scope, so a handler cannot reach the desktop
 * without them.
 */
const handlers = {
  computer_status: () => withComputerAccess((service) => service.status),
  computer_screenshot: (input) => withComputerAccess((service) => service.screenshot(input)),
  computer_list_windows: (input) => withComputerAccess((service) => service.listWindows(input)),
  computer_focus_window: (input) => withComputerAccess((service) => service.focusWindow(input)),
  computer_input: (input) => withComputerAccess((service, scope) => service.input(scope, input)),
  computer_manage_display: (input) => withComputerAccess((service) => service.manageDisplay(input)),
  computer_launch: (input) => withComputerAccess((service) => service.launch(input)),
} satisfies Parameters<typeof ComputerToolkit.toLayer>[0];

const { computer_screenshot, ...standardHandlers } = handlers;

export const ComputerStandardToolkitHandlersLive =
  ComputerStandardToolkit.toLayer(standardHandlers);

export const ComputerScreenshotToolkitHandlersLive = ComputerScreenshotToolkit.toLayer({
  computer_screenshot,
});
