import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OpenbotChannelId, OpenbotChatComputer } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/atomRuntime";
import { useAtomCommand } from "./channels";
import { commandErrorText } from "./errors";

/**
 * The computer a chat works on.
 *
 * Everything here is keyed by a chat, never by a display: the server owns the
 * mapping, so a child chat can be asked about its own id and still get the
 * parent's screen back. The display id inside the answer is ephemeral and is
 * only ever used to open a frame socket (`computerStream.ts`) — frames never
 * travel over these RPCs, so a 12 fps JPEG stream cannot block an agent.
 */

/** The chat's computer as it stands, without provisioning one. */
export const getChatComputer = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:chat-computer-get",
  tag: WS_METHODS.openbotChatComputerGet,
});

/** Provisions this chat's display on first use, then describes it. */
export const ensureChatComputer = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:chat-computer-ensure",
  tag: WS_METHODS.openbotChatComputerEnsure,
});

/** One screenshot, on demand. Still useful where a live stream is overkill. */
export const getChatComputerSnapshot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:chat-computer-snapshot",
  tag: WS_METHODS.openbotChatComputerSnapshot,
});

export const focusChatComputerWindow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:chat-computer-window-focus",
  tag: WS_METHODS.openbotChatComputerWindowFocus,
});

/** Opens an app onto this chat's display. Refused when it cannot be placed there. */
export const launchChatComputerApp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:chat-computer-launch",
  tag: WS_METHODS.openbotChatComputerLaunch,
});

/** Ordered input for callers without a frame socket. */
export const sendChatComputerInput = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:chat-computer-input",
  tag: WS_METHODS.openbotChatComputerInput,
});

const chatComputerSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "openbot:chat-computer-stream",
  tag: WS_METHODS.openbotChatComputerSubscribe,
  // The card and the page share one subscription; keep it briefly so opening
  // the page from the card does not re-ask the host for the whole thing.
  idleTtlMs: 30_000,
});

export interface ChatComputerState {
  readonly computer: OpenbotChatComputer | null;
  /** True until the first answer arrives; "no computer" and "not yet" differ. */
  readonly loading: boolean;
  /** Set when the subscription itself failed. */
  readonly error: string | null;
}

const LOADING: ChatComputerState = { computer: null, loading: true, error: null };
const NO_CHAT: ChatComputerState = { computer: null, loading: false, error: null };
const NO_CHAT_ATOM = Atom.make(NO_CHAT).pipe(Atom.withLabel("openbot-chat-computer:none"));

const chatComputerValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((channelId: OpenbotChannelId) =>
    Atom.make((get): ChatComputerState => {
      const result = get(chatComputerSubscription({ environmentId, input: { channelId } }));
      if (AsyncResult.isSuccess(result)) {
        return { computer: result.value, loading: false, error: null };
      }
      if (AsyncResult.isFailure(result)) {
        return { computer: null, loading: false, error: commandErrorText(result) };
      }
      return LOADING;
    }).pipe(Atom.withLabel(`openbot-chat-computer:${environmentId}:${channelId}`)),
  ),
);

/**
 * Live state of the chat's computer: whether it exists yet, the display to
 * stream, the windows on it, and who is controlling. Without a chat nothing is
 * subscribed, so a fresh account with no chats asks the host for nothing.
 */
export function useChatComputer(
  environmentId: EnvironmentId,
  channelId: OpenbotChannelId | null,
): ChatComputerState {
  return useAtomValue(
    channelId === null ? NO_CHAT_ATOM : chatComputerValueAtom(environmentId)(channelId),
  );
}

/**
 * Asks the host to provision this chat's display, once per chat.
 *
 * `ensure` is idempotent on the server, but a request per render would still
 * be a request per keystroke, so the chat it has already been asked for is
 * remembered. Returns the failure text when the host refused, which is worth
 * showing only until the subscription has something better to say.
 */
export function useEnsureChatComputer(
  environmentId: EnvironmentId,
  channelId: OpenbotChannelId | null,
): string | null {
  const [error, setError] = useState<string | null>(null);
  const run = useAtomCommand(ensureChatComputer, { reportFailure: false });
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (channelId === null) return;
    const key = `${environmentId} ${channelId}`;
    if (askedRef.current === key) return;
    askedRef.current = key;
    setError(null);
    void run({ environmentId, input: { channelId } }).then((result) => {
      setError(result._tag === "Failure" ? commandErrorText(result) : null);
    });
  }, [channelId, environmentId, run]);
  return error;
}
