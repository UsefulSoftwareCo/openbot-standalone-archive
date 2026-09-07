import {
  CommandId,
  MessageId,
  type ModelSelection,
  OpenbotChannel,
  OpenbotChannelCreateInput,
  OpenbotChannelId,
  type OpenbotChannelListResult,
  type OpenbotChannelSendInput,
  type OpenbotChannelSendResult,
  type OpenbotChannelStatus,
  type OpenbotChannelView,
  type OpenbotDelivery,
  OpenbotDeliveryId,
  OpenbotError,
  type OpenbotIncomingMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ServerProvider,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isProviderAvailable,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import {
  isActiveRun,
  isTerminalRunStatus,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderTurnInstructionsV2 } from "../orchestration-v2/TurnInstructions.ts";
import { OpenbotChannelStore } from "./OpenbotChannelStore.ts";

/**
 * OpenBot channels on top of Orchestrator v2.
 *
 * A channel is one v2 thread inside one server-owned project. Sending into a
 * channel is a plain `message.dispatch` with `queue_after_active`, so the
 * orchestrator's per-thread lock, queue ordering, and one-run-per-thread
 * invariant are the only scheduler. This service adds the channel mapping,
 * the app instructions for each turn, explicit deliveries, and a read model
 * that reports each accepted message's state independently of reply count.
 */
export const OPENBOT_WORKSPACE_DIRNAME = "openbot";

export const openbotTurnInstructions = (input: {
  readonly channelName: string;
}): string => `You are OpenBot, the resident agent in the "${input.channelName}" channel of a persistent chat. The person reads this channel like a messaging app; they cannot see your reasoning, tool calls, or ordinary assistant text.

Delivery contract:
- The ONLY way to reach the person is the \`openbot_send_message\` tool (it may appear as \`mcp__t3-code__openbot_send_message\`). Call it with the complete text of a message. Call it once for one coherent reply, or several times for separate useful updates while you work.
- If the incoming message needs no reply (an acknowledgement, a note to self, or a request you already answered in the same turn), call \`openbot_skip_reply\` instead of staying silent. A turn that ends with neither tool is shown to the person as unanswered.
- Never repeat a message you already sent in this turn. Do not restate a delivered message as plain assistant text.
- Several messages may arrive while you are working. Each starts its own turn after this one ends; treat later messages in the channel history as newer context.

Keep messages short and direct, like chat.`;

export interface OpenbotChannelServiceShape {
  readonly list: Effect.Effect<OpenbotChannelListResult, OpenbotError>;
  readonly subscribeList: Stream.Stream<OpenbotChannelListResult, OpenbotError>;
  readonly create: (
    input: OpenbotChannelCreateInput,
  ) => Effect.Effect<OpenbotChannel, OpenbotError>;
  readonly getView: (
    channelId: OpenbotChannelId,
  ) => Effect.Effect<OpenbotChannelView, OpenbotError>;
  readonly subscribeView: (
    channelId: OpenbotChannelId,
  ) => Stream.Stream<OpenbotChannelView, OpenbotError>;
  readonly send: (
    input: OpenbotChannelSendInput,
  ) => Effect.Effect<OpenbotChannelSendResult, OpenbotError>;
  readonly channelForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OpenbotChannel | undefined, OpenbotError>;
  /**
   * Record an explicit user-visible delivery (or an explicit decision not to
   * reply) for the channel's active run. Rejected when no run is active so a
   * stale tool call cannot attach to the next message's turn.
   */
  readonly recordDelivery: (input: {
    readonly threadId: ThreadId;
    readonly kind: OpenbotDelivery["kind"];
    readonly text: string;
    readonly requestKey: string;
  }) => Effect.Effect<
    { readonly delivery: OpenbotDelivery; readonly deliveredInRun: number },
    OpenbotError | OpenbotNoActiveRunError
  >;
}

export class OpenbotNoActiveRunError extends Schema.TaggedErrorClass<OpenbotNoActiveRunError>()(
  "OpenbotNoActiveRunError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no active run to deliver into.`;
  }
}

export class OpenbotChannelService extends Context.Service<
  OpenbotChannelService,
  OpenbotChannelServiceShape
>()("t3/openbot/OpenbotChannelService") {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const orchestrationError = (message: string, channelId?: OpenbotChannelId) => (cause: unknown) =>
  new OpenbotError({
    code: "orchestration_error",
    message: `${message}: ${errorMessage(cause)}`,
    ...(channelId === undefined ? {} : { channelId }),
    cause,
  });

function chooseDefaultProvider(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | undefined {
  const usable = providers.filter(
    (provider) =>
      isProviderAvailable(provider) &&
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.models.length > 0,
  );
  const ranked = usable.toSorted((left, right) => {
    const authScore = (provider: ServerProvider) =>
      provider.auth.status === "authenticated" ? 0 : provider.auth.status === "unknown" ? 1 : 2;
    return authScore(left) - authScore(right);
  });
  const provider = ranked[0];
  if (provider === undefined) return undefined;
  const model = provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  return model === undefined ? undefined : { instanceId: provider.instanceId, model: model.slug };
}

function runForMessage(
  projection: OrchestrationV2ThreadProjection,
  messageId: MessageId,
): OrchestrationV2Run | undefined {
  return projection.runs.find((run) => run.userMessageId === messageId);
}

function failureForRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): string | null {
  const error = projection.turnItems.findLast(
    (item) => item.runId === run.id && item.type === "error",
  );
  return error?.type === "error" ? error.failure.message : null;
}

export function buildIncomingMessages(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly deliveries: ReadonlyArray<OpenbotDelivery>;
}): ReadonlyArray<OpenbotIncomingMessage> {
  const deliveriesByRun = new Map<RunId, ReadonlyArray<OpenbotDelivery>>();
  for (const delivery of input.deliveries) {
    deliveriesByRun.set(delivery.runId, [...(deliveriesByRun.get(delivery.runId) ?? []), delivery]);
  }
  return input.projection.messages
    .filter((message) => message.role === "user" && message.createdBy === "user")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map((message): OpenbotIncomingMessage => {
      const run = runForMessage(input.projection, message.id);
      const base = {
        id: message.id,
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        text: message.text,
        createdAt: DateTime.formatIso(message.createdAt),
      };
      if (run === undefined) {
        // Steered or edited-away messages have no run of their own.
        return { ...base, state: "handled", outcome: null, error: null };
      }
      if (run.status === "queued" || run.status === "preparing") {
        return { ...base, state: "pending", outcome: null, error: null };
      }
      if (isActiveRun(run)) {
        return { ...base, state: "working", outcome: null, error: null };
      }
      const runDeliveries = deliveriesByRun.get(run.id) ?? [];
      if (run.status === "failed") {
        return {
          ...base,
          state: "failed",
          outcome: "failed",
          error: failureForRun(input.projection, run) ?? "The agent run failed.",
        };
      }
      if (
        run.status === "cancelled" ||
        run.status === "interrupted" ||
        run.status === "rolled_back"
      ) {
        return {
          ...base,
          state: "failed",
          outcome: "failed",
          error: `The agent run was ${run.status.replace("_", " ")}.`,
        };
      }
      const replied = runDeliveries.some((delivery) => delivery.kind === "message");
      const silent = runDeliveries.some((delivery) => delivery.kind === "silence");
      return {
        ...base,
        state: "handled",
        outcome: replied ? "replied" : silent ? "silent" : "no_reply",
        error: null,
      };
    });
}

export function deriveChannelStatus(
  projection: OrchestrationV2ThreadProjection,
): OpenbotChannelStatus {
  const active = projection.runs.find(isActiveRun);
  if (active !== undefined) {
    return active.status === "waiting" ? "waiting" : "working";
  }
  if (projection.runs.some((run) => run.status === "queued")) return "working";
  const latest = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return latest !== undefined && latest.status === "failed" ? "failed" : "idle";
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* OpenbotChannelStore;
  const projects = yield* ProjectService.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const vcs = yield* VcsProvisioningService.VcsProvisioningService;
  const threads = yield* ThreadManagementService;
  const ids = yield* IdAllocatorV2;
  const channelsChanged = yield* PubSub.sliding<void>(1);
  const notifyChannelsChanged = PubSub.publish(channelsChanged, undefined).pipe(Effect.asVoid);
  // Deliveries are app-owned writes outside the v2 event log, so a channel
  // view needs its own change signal in addition to the thread event stream.
  const deliveriesChanged = yield* PubSub.unbounded<OpenbotChannelId>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const list: OpenbotChannelServiceShape["list"] = store.list.pipe(
    Effect.map((channels) => ({ channels })),
    Effect.mapError(orchestrationError("Unable to list channels")),
  );

  const subscribeList: OpenbotChannelServiceShape["subscribeList"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(channelsChanged);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );

  const channelForThread: OpenbotChannelServiceShape["channelForThread"] = (threadId) =>
    store
      .getByThreadId(threadId)
      .pipe(Effect.mapError(orchestrationError("Unable to resolve the channel for a thread")));

  const requireChannel = (channelId: OpenbotChannelId) =>
    store.getById(channelId).pipe(
      Effect.mapError(orchestrationError("Unable to load channel", channelId)),
      Effect.flatMap((channel) =>
        channel === undefined
          ? Effect.fail(
              new OpenbotError({
                code: "channel_not_found",
                message: `Channel ${channelId} was not found.`,
                channelId,
              }),
            )
          : Effect.succeed(channel),
      ),
    );

  // Every channel thread lives in one server-owned project rooted under the
  // T3 state directory. Provider sessions need a real cwd; this keeps agent
  // work out of the user's repositories until a channel is bound to one. The
  // directory is its own git repository so run checkpoints work the same
  // whether or not the state directory sits inside another checkout.
  const ensureWorkspaceProject = Effect.gen(function* () {
    const workspaceRoot = path.join(config.stateDir, OPENBOT_WORKSPACE_DIRNAME);
    yield* fileSystem
      .makeDirectory(workspaceRoot, { recursive: true })
      .pipe(Effect.mapError(orchestrationError("Unable to create the OpenBot workspace")));
    const hasRepository = yield* fileSystem
      .exists(path.join(workspaceRoot, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasRepository) {
      yield* vcs
        .initRepository({ cwd: workspaceRoot, kind: "git" })
        .pipe(Effect.mapError(orchestrationError("Unable to initialize the OpenBot workspace")));
    }
    const existing = yield* projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(Effect.mapError(orchestrationError("Unable to look up the OpenBot project")));
    if (Option.isSome(existing) && existing.value.deletedAt === null) {
      return existing.value;
    }
    const projectId = yield* ids.allocate
      .project({ fixtureName: "openbot" })
      .pipe(Effect.mapError(orchestrationError("Unable to allocate the OpenBot project id")));
    return yield* projects
      .create({
        commandId: CommandId.make(`command:openbot:project:${projectId}`),
        projectId,
        title: "OpenBot",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OpenbotError({
              code: "project_unavailable",
              message: `Unable to create the OpenBot project: ${errorMessage(cause)}`,
              cause,
            }),
        ),
      );
  });

  const resolveModelSelection = (requested: ModelSelection | undefined) =>
    requested === undefined
      ? providerRegistry.getProviders.pipe(
          Effect.flatMap((providers) => {
            const selection = chooseDefaultProvider(providers);
            return selection === undefined
              ? Effect.fail(
                  new OpenbotError({
                    code: "no_provider_available",
                    message:
                      "No agent provider is installed and enabled. Set one up in T3 Code first.",
                  }),
                )
              : Effect.succeed(selection);
          }),
        )
      : Effect.succeed(requested);

  const create: OpenbotChannelServiceShape["create"] = Effect.fn("OpenbotChannelService.create")(
    function* (input) {
      const project = yield* ensureWorkspaceProject;
      const modelSelection = yield* resolveModelSelection(input.modelSelection);
      const channelId = OpenbotChannelId.make(
        `openbot-channel:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
      );
      const threadId = yield* ids.allocate
        .thread({ projectId: project.id })
        .pipe(Effect.mapError(orchestrationError("Unable to allocate the channel thread id")));
      const commandId =
        input.commandId ?? CommandId.make(`command:openbot:channel-create:${channelId}`);
      yield* threads
        .dispatch({
          type: "thread.create",
          commandId,
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: project.id,
          title: input.name,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
        })
        .pipe(Effect.mapError(orchestrationError("Unable to create the channel thread")));
      const now = yield* nowIso;
      const channel: OpenbotChannel = {
        id: channelId,
        name: input.name,
        projectId: project.id,
        threadId,
        modelSelection,
        createdAt: now,
        updatedAt: now,
      };
      yield* store
        .insert(channel)
        .pipe(Effect.mapError(orchestrationError("Unable to save the channel", channelId)));
      yield* notifyChannelsChanged;
      return channel;
    },
  );

  const viewFor = (channel: OpenbotChannel) =>
    Effect.gen(function* () {
      const projection = yield* threads
        .getThreadProjection(channel.threadId)
        .pipe(Effect.mapError(orchestrationError("Unable to load the channel thread", channel.id)));
      const deliveries = yield* store
        .listDeliveries(channel.id)
        .pipe(Effect.mapError(orchestrationError("Unable to load channel deliveries", channel.id)));
      const messages = buildIncomingMessages({ projection, deliveries });
      return {
        channel,
        status: deriveChannelStatus(projection),
        pendingCount: messages.filter((message) => message.state === "pending").length,
        messages,
        deliveries,
      } satisfies OpenbotChannelView;
    });

  const getView: OpenbotChannelServiceShape["getView"] = (channelId) =>
    requireChannel(channelId).pipe(Effect.flatMap(viewFor));

  const subscribeView: OpenbotChannelServiceShape["subscribeView"] = (channelId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const channel = yield* requireChannel(channelId);
        const deliverySubscription = yield* PubSub.subscribe(deliveriesChanged);
        const afterSequence = yield* threads
          .getThreadEventSequence(channel.threadId)
          .pipe(
            Effect.mapError(orchestrationError("Unable to read the channel thread", channelId)),
          );
        const threadChanges = threads
          .streamStoredEventsFrom({ threadId: channel.threadId, afterSequence })
          .pipe(
            Stream.mapError(orchestrationError("Channel thread stream failed", channelId)),
            Stream.map(() => undefined),
          );
        const deliveryChanges = Stream.fromSubscription(deliverySubscription).pipe(
          Stream.filter((changed) => changed === channelId),
          Stream.map(() => undefined),
        );
        return Stream.concat(
          Stream.fromEffect(viewFor(channel)),
          Stream.merge(threadChanges, deliveryChanges).pipe(
            // Coalesce bursts (a run emits many events per second) into one view.
            Stream.debounce("40 millis"),
            Stream.mapEffect(() => viewFor(channel)),
          ),
        );
      }),
    );

  const send: OpenbotChannelServiceShape["send"] = Effect.fn("OpenbotChannelService.send")(
    function* (input) {
      const channel = yield* requireChannel(input.channelId);
      const messageId =
        input.messageId ??
        MessageId.make(`message:openbot:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
      const commandId = input.commandId ?? CommandId.make(`command:openbot:send:${messageId}`);
      const result = yield* threads
        .sendToThread({
          projectId: channel.projectId,
          commandId,
          threadId: channel.threadId,
          messageId,
          text: input.text,
          attachments: [],
          // Step 1 contract: never steer or restart. A message that arrives
          // during a run waits for its own turn behind the active one.
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(orchestrationError("Unable to send the message", channel.id)));
      return {
        channelId: channel.id,
        messageId,
        runId: result.run.id,
        status: result.run.status,
        delivery: result.delivery === "queued" ? "queued" : "started",
      } satisfies OpenbotChannelSendResult;
    },
  );

  const recordDelivery: OpenbotChannelServiceShape["recordDelivery"] = Effect.fn(
    "OpenbotChannelService.recordDelivery",
  )(function* (input) {
    const channel = yield* channelForThread(input.threadId);
    if (channel === undefined) {
      return yield* new OpenbotError({
        code: "channel_not_found",
        message: `Thread ${input.threadId} is not an OpenBot channel.`,
      });
    }
    const projection = yield* threads
      .getThreadProjection(channel.threadId)
      .pipe(Effect.mapError(orchestrationError("Unable to load the channel thread", channel.id)));
    const activeRun = projection.runs.find(isActiveRun);
    if (activeRun === undefined) {
      return yield* new OpenbotNoActiveRunError({ threadId: input.threadId });
    }
    const delivery: OpenbotDelivery = {
      id: OpenbotDeliveryId.make(`openbot-delivery:${activeRun.id}:${input.requestKey}`),
      channelId: channel.id,
      runId: activeRun.id,
      kind: input.kind,
      text: input.text,
      createdAt: yield* nowIso,
    };
    const existing = yield* store
      .listDeliveries(channel.id)
      .pipe(Effect.mapError(orchestrationError("Unable to load channel deliveries", channel.id)));
    const duplicate = existing.find((candidate) => candidate.id === delivery.id);
    if (duplicate === undefined) {
      yield* store
        .insertDelivery(delivery)
        .pipe(Effect.mapError(orchestrationError("Unable to save the delivery", channel.id)));
      yield* PubSub.publish(deliveriesChanged, channel.id);
    }
    const deliveredInRun = yield* store
      .countDeliveriesForRun(activeRun.id)
      .pipe(Effect.mapError(orchestrationError("Unable to count deliveries", channel.id)));
    return { delivery: duplicate ?? delivery, deliveredInRun };
  });

  // Terminal statuses do not need an explicit reconcile here: the view is
  // derived from the v2 projection on every thread event, so a run ending
  // (with or without a delivery) is visible through the thread stream.
  void isTerminalRunStatus;

  return OpenbotChannelService.of({
    list,
    subscribeList,
    create,
    getView,
    subscribeView,
    send,
    channelForThread,
    recordDelivery,
  });
});

export const layer = Layer.effect(OpenbotChannelService, make);

/** Provider-turn instructions for channel threads; a no-op for every other thread. */
export const turnInstructionsLayer = Layer.effect(
  ProviderTurnInstructionsV2,
  Effect.gen(function* () {
    const store = yield* OpenbotChannelStore;
    return {
      resolve: ({ threadId }) =>
        store.getByThreadId(threadId).pipe(
          Effect.map((channel) =>
            channel === undefined
              ? undefined
              : openbotTurnInstructions({ channelName: channel.name }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("openbot turn instructions unavailable", { threadId, cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        ),
    };
  }),
);
