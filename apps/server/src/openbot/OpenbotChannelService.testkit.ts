import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ModelSelection,
  type OrchestrationV2Run,
  type ServerProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { layer as projectionStoreLayer } from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { VcsProvisioningService } from "../vcs/VcsProvisioningService.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import {
  layer as openbotChannelServiceLayer,
  turnInstructionsLayer,
} from "./OpenbotChannelService.ts";
import { layer as openbotChannelStoreLayer } from "./OpenbotChannelStore.ts";

/**
 * The OpenBot service under a real orchestrator v2 on an in-memory database,
 * with a provider adapter that never opens a session. Runs reach `starting`
 * and stop there, so a test drives lifecycle by writing events itself.
 */
export const openbotModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: openbotModelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not opened by these tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: openbotModelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

/** The one provider these tests offer; exported for suites that need their own registry. */
export const openbotServerProvider = {
  instanceId: openbotModelSelection.instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-06T00:00:00.000Z",
  models: [
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
} as unknown as ServerProvider;

const orchestrationLayer = OrchestrationV2LayerLive.pipe(Layer.provide(ProjectServiceLayerLive));

export const makeOpenbotTestLayer = (prefix: string) => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix });
  return Layer.mergeAll(
    openbotChannelServiceLayer.pipe(
      Layer.provide(Layer.mergeAll(openbotChannelStoreLayer, orchestrationLayer, idAllocatorLayer)),
    ),
    turnInstructionsLayer.pipe(
      Layer.provide(Layer.merge(openbotChannelStoreLayer, projectionStoreLayer)),
    ),
    orchestrationLayer,
    OrchestrationV2EventSinkLayerLive,
  ).pipe(
    Layer.provideMerge(ProjectServiceLayerLive),
    Layer.provide(
      Layer.mock(ProjectEnrichmentService)({
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([openbotServerProvider]) }),
    ),
    Layer.provide(Layer.mock(VcsProvisioningService)({ initRepository: () => Effect.void })),
    Layer.provide(mcpSessionRegistryTestLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(
      CheckpointStore.layer.pipe(
        Layer.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(serverConfigLayer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
    Layer.provideMerge(serverConfigLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
        listInstances: Effect.succeed([providerInstance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
        createWorktree: () => Effect.succeed({} as never),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Ends a run the way a provider would, so the next queued run is promoted. */
export const completeRun = (threadId: ThreadId, run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const completedAt = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: `event:openbot-test:${run.id}:completed` as never,
          type: "run.updated",
          threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: completedAt,
          payload: { ...run, status: "completed", completedAt },
        },
      ],
    });
  });

/** Resolves with each run id as it is promoted to `starting`. */
export const watchPromotions = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const promoted = yield* Queue.unbounded<RunId>();
    const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* eventSink.stream({ threadId, afterSequence }).pipe(
      Stream.runForEach((stored) =>
        stored.event.type === "run.updated" && stored.event.payload.status === "starting"
          ? Queue.offer(promoted, stored.event.payload.id)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return promoted;
  });
