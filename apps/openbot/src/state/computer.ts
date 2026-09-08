import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OpenbotComputerStatus } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/atomRuntime";
import { commandErrorText } from "./errors";

/**
 * The host's desktop session.
 *
 * Status is a subscription because displays appear, permissions get granted
 * and the input lease changes hands while the user is looking at it; a card
 * that had to be refreshed by hand would be wrong more often than right.
 * Frames never travel here — they have their own socket (`computerStream.ts`)
 * so a 12 fps JPEG stream cannot block an agent's RPC.
 */

/** One screenshot, on demand. Still useful where a live stream is overkill. */
export const getComputerSnapshot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-snapshot",
  tag: WS_METHODS.openbotComputerSnapshot,
});

/** A one-shot read for callers outside a React subscription. */
export const getComputerStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-status",
  tag: WS_METHODS.openbotComputerStatus,
});

export const listComputerWindows = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-windows",
  tag: WS_METHODS.openbotComputerWindowsList,
});

export const focusComputerWindow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-window-focus",
  tag: WS_METHODS.openbotComputerWindowFocus,
});

export const createComputerDisplay = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-display-create",
  tag: WS_METHODS.openbotComputerDisplayCreate,
});

export const destroyComputerDisplay = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-display-destroy",
  tag: WS_METHODS.openbotComputerDisplayDestroy,
});

/** Ordered input on the shared desktop, for callers without a frame socket. */
export const sendComputerInput = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-input",
  tag: WS_METHODS.openbotComputerInput,
});

export const setComputerControl = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-control",
  tag: WS_METHODS.openbotComputerControl,
});

export const launchComputerApp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:computer-launch",
  tag: WS_METHODS.openbotComputerLaunch,
});

const computerStatusSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "openbot:computer-status-stream",
    tag: WS_METHODS.openbotComputerSubscribe,
    // The card and the page share one subscription; keep it briefly so opening
    // the page from the card does not re-ask the host for its whole state.
    idleTtlMs: 30_000,
  },
);

export interface ComputerStatusState {
  readonly status: OpenbotComputerStatus | null;
  /** True until the first status arrives; "no computer" and "not yet" differ. */
  readonly loading: boolean;
  /** Set when the subscription itself failed. */
  readonly error: string | null;
}

const LOADING_STATUS: ComputerStatusState = { status: null, loading: true, error: null };
const LOADING_STATUS_ATOM = Atom.make(LOADING_STATUS).pipe(
  Atom.withLabel("openbot-computer-status:empty"),
);

const computerStatusValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ComputerStatusState => {
    const result = get(computerStatusSubscription({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(result)) {
      return { status: result.value, loading: false, error: null };
    }
    if (AsyncResult.isFailure(result)) {
      return { status: null, loading: false, error: commandErrorText(result) };
    }
    return LOADING_STATUS;
  }).pipe(Atom.withLabel(`openbot-computer-status:${environmentId}`)),
);

/** Live desktop status: displays, windows, permissions and who is controlling. */
export function useComputerStatus(environmentId: EnvironmentId | null): ComputerStatusState {
  return useAtomValue(
    environmentId === null ? LOADING_STATUS_ATOM : computerStatusValueAtom(environmentId),
  );
}

/** Prefers the main display, then the first the host reported. */
export function preferredDisplay(
  status: OpenbotComputerStatus | null,
): OpenbotComputerStatus["displays"][number] | null {
  if (status === null) return null;
  return status.displays.find((display) => display.main) ?? status.displays[0] ?? null;
}
