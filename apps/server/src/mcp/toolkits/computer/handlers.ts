import { withComputerAccess } from "./ComputerMcpService.ts";
import { ComputerScreenshotToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

/**
 * Every computer tool is one gated service call. `withComputerAccess` owns both
 * the capability check and the scope, so a handler cannot reach a desktop
 * without them — and the scope is also what says which chat's computer this
 * thread means, so no handler can pick a screen for itself.
 */
const handlers = {
  computer_status: () => withComputerAccess((service, scope) => service.status(scope)),
  computer_screenshot: (input) =>
    withComputerAccess((service, scope) => service.screenshot(scope, input)),
  computer_list_windows: () => withComputerAccess((service, scope) => service.listWindows(scope)),
  computer_focus_window: (input) =>
    withComputerAccess((service, scope) => service.focusWindow(scope, input)),
  computer_input: (input) => withComputerAccess((service, scope) => service.input(scope, input)),
  computer_launch: (input) => withComputerAccess((service, scope) => service.launch(scope, input)),
} satisfies Parameters<typeof ComputerToolkit.toLayer>[0];

const { computer_screenshot, ...standardHandlers } = handlers;

export const ComputerStandardToolkitHandlersLive =
  ComputerStandardToolkit.toLayer(standardHandlers);

export const ComputerScreenshotToolkitHandlersLive = ComputerScreenshotToolkit.toLayer({
  computer_screenshot,
});
