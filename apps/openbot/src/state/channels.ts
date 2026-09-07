import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";
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
  type OpenbotKnowledge,
  type OpenbotProject,
  type OpenbotProjectId,
  ORCHESTRATION_V2_WS_METHODS,
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

export const getThreadContext = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:context-get",
  tag: WS_METHODS.openbotContextGet,
});
export const updateThreadContext = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:context-update",
  tag: WS_METHODS.openbotContextUpdate,
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

const routinesSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "openbot:routines",
  tag: WS_METHODS.scheduledTasksSubscribe,
});
/** Live routine state, including loading and errors; callers scope it to their thread. */
export function useRoutines(environmentId: EnvironmentId) {
  return useAtomValue(routinesSubscription({ environmentId, input: {} }));
}
export const saveRoutine = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:routine-save",
  tag: WS_METHODS.scheduledTasksUpsert,
});
export const setRoutineEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:routine-enabled",
  tag: WS_METHODS.scheduledTasksSetEnabled,
});
export const deleteRoutine = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:routine-delete",
  tag: WS_METHODS.scheduledTasksDelete,
});
export const testRoutine = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:routine-test",
  tag: WS_METHODS.scheduledTasksRunNow,
});
export const getRoutineThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:routine-history",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
});

/** Upload grants use the same environment connection as messages. */
export const createAttachmentUpload = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:attachment-upload",
  tag: WS_METHODS.attachmentsCreateUploadUrl,
});
/** Resolve signed asset URLs for image previews and downloads. */
export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);
/** Server config: configured providers, their advertised models, and the environment label. */
export const getServerConfig = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:server-config",
  tag: WS_METHODS.serverGetConfig,
});

/** Save a chat's profile and model with a revision precondition. */
export const updateChannel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:channel-update",
  tag: WS_METHODS.openbotChannelUpdate,
});

// --- Projects -------------------------------------------------------------

const projectsSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "openbot:projects",
  tag: WS_METHODS.openbotProjectsSubscribe,
});

const EMPTY_PROJECTS: ReadonlyArray<OpenbotProject> = Object.freeze([]);
const EMPTY_PROJECTS_ATOM = Atom.make(EMPTY_PROJECTS).pipe(
  Atom.withLabel("openbot-projects:empty"),
);

const projectsValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      Option.getOrElse(
        AsyncResult.value(get(projectsSubscription({ environmentId, input: {} }))),
        () => ({ projects: EMPTY_PROJECTS }),
      ).projects,
  ).pipe(Atom.withLabel(`openbot-projects:${environmentId}`)),
);

export function useProjects(environmentId: EnvironmentId | null): ReadonlyArray<OpenbotProject> {
  return useAtomValue(
    environmentId === null ? EMPTY_PROJECTS_ATOM : projectsValueAtom(environmentId),
  );
}

export const createProject = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:project-create",
  tag: WS_METHODS.openbotProjectsCreate,
});
/** Compare-and-swap; a stale revision fails so a concurrent edit is never lost. */
export const updateProject = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:project-update",
  tag: WS_METHODS.openbotProjectUpdate,
});
export const getProject = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:project-get",
  tag: WS_METHODS.openbotProjectGet,
});

// --- Knowledge ------------------------------------------------------------

const knowledgeSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "openbot:knowledge",
  tag: WS_METHODS.openbotKnowledgeSubscribe,
});

const EMPTY_KNOWLEDGE: ReadonlyArray<OpenbotKnowledge> = Object.freeze([]);
const EMPTY_KNOWLEDGE_ATOM = Atom.make(EMPTY_KNOWLEDGE).pipe(
  Atom.withLabel("openbot-knowledge:empty"),
);

const knowledgeValueAtom = Atom.family((key: string) => {
  const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, OpenbotProjectId | null];
  const input = projectId === null ? {} : { projectId };
  return Atom.make(
    (get) =>
      Option.getOrElse(
        AsyncResult.value(get(knowledgeSubscription({ environmentId, input }))),
        () => ({ entries: EMPTY_KNOWLEDGE }),
      ).entries,
  ).pipe(Atom.withLabel(`openbot-knowledge:${key}`));
});

/** Live knowledge entries; pass a project id to see only the entries linked to it. */
export function useKnowledge(
  environmentId: EnvironmentId | null,
  projectId: OpenbotProjectId | null = null,
): ReadonlyArray<OpenbotKnowledge> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_KNOWLEDGE_ATOM
      : knowledgeValueAtom(JSON.stringify([environmentId, projectId])),
  );
}

export const createKnowledge = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:knowledge-create",
  tag: WS_METHODS.openbotKnowledgeCreate,
});
export const updateKnowledge = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:knowledge-update",
  tag: WS_METHODS.openbotKnowledgeUpdate,
});
export const deleteKnowledge = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:knowledge-delete",
  tag: WS_METHODS.openbotKnowledgeDelete,
});

// --- Threads --------------------------------------------------------------

/** Create a child chat and dispatch its first work request in one durable step. */
export const startThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:thread-start",
  tag: WS_METHODS.openbotThreadStart,
});

// --- Chat controls --------------------------------------------------------

export const snoozeChannel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:channel-snooze",
  tag: WS_METHODS.openbotChannelSnooze,
});
export const wakeChannel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:channel-wake",
  tag: WS_METHODS.openbotChannelWake,
});
/** Interrupts the active run and drops what is queued behind it. */
export const cancelChannel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:channel-cancel",
  tag: WS_METHODS.openbotChannelCancel,
});
