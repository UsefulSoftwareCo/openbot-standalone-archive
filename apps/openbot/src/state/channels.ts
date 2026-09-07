import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type OpenbotChannel,
  type OpenbotChannelId,
  type OpenbotChannelView,
  WS_METHODS,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useContext } from "react";

import { connectionAtomRuntime } from "../connection/atomRuntime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

/** The same-origin T3 server; null until the descriptor has been discovered. */
export const primaryEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("openbot-primary-environment-id"));

const channelsSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "openbot:channels",
  tag: WS_METHODS.openbotChannelsSubscribe,
});

const channelViewSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "openbot:channel-view",
  tag: WS_METHODS.openbotChannelSubscribe,
  // Keep the last channel's view alive briefly so switching back is instant.
  idleTtlMs: 60_000,
});

export const createChannel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:channel-create",
  tag: WS_METHODS.openbotChannelsCreate,
});

export const sendChannelMessage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:channel-send",
  tag: WS_METHODS.openbotChannelSend,
});

const EMPTY_CHANNELS: ReadonlyArray<OpenbotChannel> = Object.freeze([]);
const EMPTY_CHANNELS_ATOM = Atom.make(EMPTY_CHANNELS).pipe(
  Atom.withLabel("openbot-channels:empty"),
);
const EMPTY_VIEW_ATOM = Atom.make<OpenbotChannelView | null>(null).pipe(
  Atom.withLabel("openbot-channel-view:empty"),
);
const EMPTY_CONNECTION_STATE_ATOM = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE)).pipe(
  Atom.withLabel("openbot-connection-state:empty"),
);

const channelsValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      Option.getOrElse(
        AsyncResult.value(get(channelsSubscription({ environmentId, input: {} }))),
        () => ({ channels: EMPTY_CHANNELS }),
      ).channels,
  ).pipe(Atom.withLabel(`openbot-channels:${environmentId}`)),
);

const channelViewValueAtom = Atom.family((key: string) => {
  const [environmentId, channelId] = JSON.parse(key) as [EnvironmentId, OpenbotChannelId];
  return Atom.make((get) =>
    Option.getOrNull(
      AsyncResult.value(get(channelViewSubscription({ environmentId, input: { channelId } }))),
    ),
  ).pipe(Atom.withLabel(`openbot-channel-view:${key}`));
});

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useChannels(environmentId: EnvironmentId | null): ReadonlyArray<OpenbotChannel> {
  return useAtomValue(
    environmentId === null ? EMPTY_CHANNELS_ATOM : channelsValueAtom(environmentId),
  );
}

export function useChannelView(
  environmentId: EnvironmentId | null,
  channelId: OpenbotChannelId | null,
): OpenbotChannelView | null {
  return useAtomValue(
    environmentId === null || channelId === null
      ? EMPTY_VIEW_ATOM
      : channelViewValueAtom(JSON.stringify([environmentId, channelId])),
  );
}

export function useConnectionPhase(environmentId: EnvironmentId | null) {
  const state = useAtomValue(
    environmentId === null
      ? EMPTY_CONNECTION_STATE_ATOM
      : environmentCatalog.stateAtom(environmentId),
  );
  const value = Option.getOrElse(AsyncResult.value(state), () => AVAILABLE_CONNECTION_STATE);
  return connectionProjectionPhase(value);
}

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  return useCallback(
    (value: W) =>
      runAtomCommand(registry, command, value, {
        label: options?.label ?? command.label,
        reportFailure: options?.reportFailure ?? true,
        reportDefect: options?.reportDefect ?? true,
      }),
    [command, options?.label, options?.reportDefect, options?.reportFailure, registry],
  );
}
