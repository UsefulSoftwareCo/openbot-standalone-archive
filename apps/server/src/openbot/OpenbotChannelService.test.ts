import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  OpenbotChannelId,
  OpenbotDeliveryId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderTurnInstructionsV2 } from "../orchestration-v2/TurnInstructions.ts";
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
  buildIncomingMessages,
  deriveChannelStatus,
  layer as openbotChannelServiceLayer,
  OpenbotChannelService,
  openbotTurnInstructions,
  turnInstructionsLayer,
} from "./OpenbotChannelService.ts";
import { layer as openbotChannelStoreLayer } from "./OpenbotChannelStore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-openbot-channel-service-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not opened by these tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const serverProvider = {
  instanceId: modelSelection.instanceId,
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

const TestLayer = Layer.mergeAll(
  openbotChannelServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(openbotChannelStoreLayer, orchestrationLayer, idAllocatorLayer)),
  ),
  turnInstructionsLayer.pipe(Layer.provide(openbotChannelStoreLayer)),
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
  Layer.provide(Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([serverProvider]) })),
  Layer.provide(Layer.mock(VcsProvisioningService)({ initRepository: () => Effect.void })),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfigLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  ),
  Layer.provide(ServerConfigLayer),
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
  Layer.provide(NodeServices.layer),
);

const completeRun = (threadId: ThreadId, run: OrchestrationV2Run) =>
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

it.layer(TestLayer)("OpenbotChannelService", (it) => {
  it.effect("accepts three rapid messages as one active run plus two queued runs, in order", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const channel = yield* channels.create({ name: "Work" });

      const sends = yield* Effect.all(
        ["first", "second", "third"].map((text) =>
          channels.send({
            channelId: channel.id,
            text,
            messageId: MessageId.make(`message:openbot-test:${text}`),
          }),
        ),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        sends.map((send) => send.delivery),
        ["started", "queued", "queued"],
      );

      const projection = yield* orchestrator.getThreadProjection(channel.threadId);
      const active = projection.runs.filter(
        (run) => run.status === "starting" || run.status === "running",
      );
      assert.equal(active.length, 1, "exactly one active root run");
      const queued = projection.runs
        .filter((run) => run.status === "queued")
        .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
      assert.deepEqual(
        queued.map((run) => run.userMessageId),
        ["message:openbot-test:second", "message:openbot-test:third"],
      );

      const view = yield* channels.getView(channel.id);
      assert.equal(view.status, "working");
      assert.equal(view.pendingCount, 2);
      assert.deepEqual(
        view.messages.map((message) => [message.text, message.state]),
        [
          ["first", "working"],
          ["second", "pending"],
          ["third", "pending"],
        ],
      );
    }),
  );

  it.effect("promotes queued messages one at a time and reports each outcome", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const channel = yield* channels.create({ name: "Life" });
      const sendIds = ["a", "b"].map((suffix) =>
        MessageId.make(`message:openbot-outcome:${suffix}`),
      );
      for (const messageId of sendIds) {
        yield* channels.send({ channelId: channel.id, text: messageId, messageId });
      }

      const promoted = yield* Queue.unbounded<RunId>();
      const afterSequence = yield* orchestrator.getThreadEventSequence(channel.threadId);
      yield* eventSink.stream({ threadId: channel.threadId, afterSequence }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting"
            ? Queue.offer(promoted, stored.event.payload.id)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const before = yield* orchestrator.getThreadProjection(channel.threadId);
      const firstRun = before.runs.find((run) => run.userMessageId === sendIds[0]);
      assert.isDefined(firstRun);

      // Reply during the first run, then finish it.
      const delivered = yield* channels.recordDelivery({
        threadId: channel.threadId,
        kind: "message",
        text: "Hello from the first turn",
        requestKey: "reply-1",
      });
      assert.equal(delivered.delivery.runId, firstRun.id);
      assert.equal(delivered.deliveredInRun, 1);
      // Idempotent retry of the same request key is not a second delivery.
      const retried = yield* channels.recordDelivery({
        threadId: channel.threadId,
        kind: "message",
        text: "Hello from the first turn",
        requestKey: "reply-1",
      });
      assert.equal(retried.deliveredInRun, 1);
      assert.equal(retried.delivery.id, delivered.delivery.id);

      yield* completeRun(channel.threadId, firstRun);
      const promotedRunId = yield* Queue.take(promoted);
      const afterFirst = yield* orchestrator.getThreadProjection(channel.threadId);
      const secondRun = afterFirst.runs.find((run) => run.userMessageId === sendIds[1]);
      assert.isDefined(secondRun);
      assert.equal(promotedRunId, secondRun.id);
      assert.equal(secondRun.status, "starting");

      // The second run ends with neither a reply nor an explicit skip.
      yield* completeRun(channel.threadId, secondRun);

      const view = yield* channels.getView(channel.id);
      assert.deepEqual(
        view.messages.map((message) => [message.state, message.outcome]),
        [
          ["handled", "replied"],
          ["handled", "no_reply"],
        ],
      );
      assert.equal(view.deliveries.length, 1);
      assert.equal(view.status, "idle");
      assert.equal(view.pendingCount, 0);

      // With no active run, a late delivery is rejected instead of attaching
      // to whichever message comes next.
      const late = yield* channels
        .recordDelivery({
          threadId: channel.threadId,
          kind: "message",
          text: "too late",
          requestKey: "late",
        })
        .pipe(Effect.flip);
      assert.equal(late._tag, "OpenbotNoActiveRunError");
    }),
  );

  it.effect("keeps channels on independent threads and injects instructions per channel", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const instructions = yield* ProviderTurnInstructionsV2;
      const orchestrator = yield* OrchestratorV2;
      const alpha = yield* channels.create({ name: "Alpha" });
      const beta = yield* channels.create({ name: "Beta" });
      assert.notEqual(alpha.threadId, beta.threadId);
      assert.equal(alpha.projectId, beta.projectId, "channels share the OpenBot project");

      yield* channels.send({ channelId: alpha.id, text: "only alpha" });
      const alphaProjection = yield* orchestrator.getThreadProjection(alpha.threadId);
      const betaProjection = yield* orchestrator.getThreadProjection(beta.threadId);
      assert.equal(alphaProjection.messages.length, 1);
      assert.equal(betaProjection.messages.length, 0);
      assert.equal(betaProjection.runs.length, 0, "beta has no run from alpha's message");

      const alphaText = yield* instructions.resolve({ threadId: alpha.threadId, runOrdinal: 1 });
      assert.equal(alphaText, openbotTurnInstructions({ channelName: "Alpha" }));
      const other = yield* instructions.resolve({
        threadId: ThreadId.make("thread:not-a-channel"),
        runOrdinal: 1,
      });
      assert.isUndefined(other);

      const listed = yield* channels.list;
      assert.deepEqual(
        listed.channels.map((channel) => channel.name),
        ["Work", "Life", "Alpha", "Beta"],
      );
    }),
  );

  it.effect("streams a fresh view when a delivery lands", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const channel = yield* channels.create({ name: "Stream" });
      yield* channels.send({ channelId: channel.id, text: "hi" });
      const views = yield* Queue.unbounded<number>();
      const fiber = yield* channels.subscribeView(channel.id).pipe(
        Stream.runForEach((view) => Queue.offer(views, view.deliveries.length)),
        Effect.forkScoped,
      );
      assert.equal(yield* Queue.take(views), 0);
      yield* channels.recordDelivery({
        threadId: channel.threadId,
        kind: "message",
        text: "hello",
        requestKey: "stream-1",
      });
      // The view stream debounces bursts on the test clock.
      yield* TestClock.adjust("100 millis");
      assert.equal(yield* Queue.take(views), 1);
      yield* Fiber.interrupt(fiber);
    }),
  );
});

it("derives message states from the projection without a delivery table", () => {
  const now = DateTime.makeUnsafe(Date.UTC(2026, 8, 6));
  const message = (id: string, runId: RunId | null): OrchestrationV2ConversationMessage => ({
    id: MessageId.make(id),
    threadId: ThreadId.make("t"),
    runId,
    nodeId: null,
    role: "user",
    text: id,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    creationSource: "web",
  });
  const run = (id: string, userMessageId: string, status: OrchestrationV2Run["status"]) =>
    ({
      id: RunId.make(id),
      threadId: ThreadId.make("t"),
      ordinal: 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(userMessageId),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    }) as OrchestrationV2Run;
  const projection = {
    thread: { id: ThreadId.make("t") },
    runs: [run("r1", "m1", "completed"), run("r2", "m2", "failed"), run("r3", "m3", "queued")],
    messages: [
      message("m1", RunId.make("r1")),
      message("m2", RunId.make("r2")),
      message("m3", RunId.make("r3")),
    ],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const messages = buildIncomingMessages({
    projection,
    deliveries: [
      {
        id: OpenbotDeliveryId.make("d1"),
        channelId: OpenbotChannelId.make("c"),
        runId: RunId.make("r1"),
        kind: "silence",
        text: "",
        createdAt: "2026-09-06T00:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(
    messages.map((entry) => [entry.state, entry.outcome]),
    [
      ["handled", "silent"],
      ["failed", "failed"],
      ["pending", null],
    ],
  );
  assert.equal(deriveChannelStatus(projection), "working");
  assert.equal(deriveChannelStatus({ ...projection, runs: [run("r2", "m2", "failed")] }), "failed");
  assert.equal(Option.isSome(Option.some(ProjectId.make("p"))), true);
  void CommandId;
});
