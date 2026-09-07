import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/atomRuntime";

/**
 * The host's desktop session. Both reads are explicit commands rather than
 * subscriptions: a capture is a real screenshot of the developer's screen, so
 * nothing here runs until the user asks for it.
 */
export const getComputerStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-status",
  tag: WS_METHODS.openbotComputerStatus,
});

export const getComputerSnapshot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-snapshot",
  tag: WS_METHODS.openbotComputerSnapshot,
});
