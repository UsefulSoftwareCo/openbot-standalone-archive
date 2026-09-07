import {
  type OpenbotMcpAskQuestionInput,
  type OpenbotMcpAskQuestionResult,
  CommandId,
  OpenbotMcpFailure,
  type OpenbotChannel,
  type OpenbotChannelId,
  type OpenbotError,
  type OpenbotKnowledge,
  type OpenbotKnowledgeDeleteInput,
  type OpenbotKnowledgeGetInput,
  type OpenbotKnowledgeListInput,
  type OpenbotKnowledgeListResult,
  type OpenbotMcpCreateChatInput,
  type OpenbotMcpCreateProjectInput,
  type OpenbotMcpKnowledgeWriteInput,
  type OpenbotMcpListThreadsInput,
  type OpenbotMcpListThreadsResult,
  type OpenbotMcpPrepareFileInput,
  type OpenbotMcpPrepareFileResult,
  type OpenbotMcpPeerResult,
  type OpenbotMcpRequestThreadInput,
  type OpenbotMcpReplyToThreadInput,
  type OpenbotMcpSendToThreadInput,
  type OpenbotMcpSetModelInput,
  type OpenbotMcpSnoozeThreadInput,
  type OpenbotMcpStartThreadInput,
  type OpenbotMcpStartThreadResult,
  type OpenbotMcpThreadControlInput,
  type OpenbotMcpThreadControlResult,
  type OpenbotMcpUpdateChatInput,
  type OpenbotMcpUpdateInstructionsInput,
  type OpenbotMcpSearchIconsInput,
  type OpenbotMcpSearchIconsResult,
  type OpenbotMcpUpdateProjectInput,
  type OpenbotProject,
  type OpenbotProjectListResult,
  type OpenbotThreadContext,
  type OpenbotMcpUpdateKnowledgeInput,
  type OpenbotMcpDeliveryResult,
  type OpenbotMcpSendMessageInput,
  type OpenbotMcpSkipReplyInput,
} from "@t3tools/contracts";
import { searchOpenbotIcons } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenbotChannelService } from "../../../openbot/OpenbotChannelService.ts";
import { OpenbotQuestionService } from "../../../openbot/OpenbotQuestionService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

/**
 * MCP surface for OpenBot. Every operation here calls the same
 * `OpenbotChannelService` method the UI RPCs call, so agent and human paths
 * share validation and persistence. The calling chat comes from the credential
 * scope, never from tool input, so a tool call can never deliver into another
 * channel, a reply target is only accepted when it belongs to that same
 * channel, and a child chat is always created under its caller.
 */
export class OpenbotMcpService extends Context.Service<
  OpenbotMcpService,
  {
    readonly askQuestion: (
      scope: McpInvocationScope,
      input: OpenbotMcpAskQuestionInput,
    ) => Effect.Effect<OpenbotMcpAskQuestionResult, OpenbotMcpFailure>;
    readonly prepareFile: (
      scope: McpInvocationScope,
      input: OpenbotMcpPrepareFileInput,
    ) => Effect.Effect<OpenbotMcpPrepareFileResult, OpenbotMcpFailure>;
    readonly requestThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpRequestThreadInput,
    ) => Effect.Effect<OpenbotMcpPeerResult, OpenbotMcpFailure>;
    readonly replyToThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpReplyToThreadInput,
    ) => Effect.Effect<OpenbotMcpPeerResult, OpenbotMcpFailure>;
    readonly getContext: (
      scope: McpInvocationScope,
    ) => Effect.Effect<OpenbotThreadContext, OpenbotMcpFailure>;
    readonly updateKnowledge: (
      scope: McpInvocationScope,
      input: OpenbotMcpUpdateKnowledgeInput,
    ) => Effect.Effect<OpenbotThreadContext, OpenbotMcpFailure>;
    readonly sendMessage: (
      scope: McpInvocationScope,
      input: OpenbotMcpSendMessageInput,
    ) => Effect.Effect<OpenbotMcpDeliveryResult, OpenbotMcpFailure>;
    readonly skipReply: (
      scope: McpInvocationScope,
      input: OpenbotMcpSkipReplyInput,
    ) => Effect.Effect<OpenbotMcpDeliveryResult, OpenbotMcpFailure>;
    readonly listProjects: (
      scope: McpInvocationScope,
    ) => Effect.Effect<OpenbotProjectListResult, OpenbotMcpFailure>;
    readonly createProject: (
      scope: McpInvocationScope,
      input: OpenbotMcpCreateProjectInput,
    ) => Effect.Effect<OpenbotProject, OpenbotMcpFailure>;
    readonly updateProject: (
      scope: McpInvocationScope,
      input: OpenbotMcpUpdateProjectInput,
    ) => Effect.Effect<OpenbotProject, OpenbotMcpFailure>;
    readonly searchIcons: (
      scope: McpInvocationScope,
      input: OpenbotMcpSearchIconsInput,
    ) => Effect.Effect<OpenbotMcpSearchIconsResult, OpenbotMcpFailure>;
    readonly knowledgeList: (
      scope: McpInvocationScope,
      input: OpenbotKnowledgeListInput,
    ) => Effect.Effect<OpenbotKnowledgeListResult, OpenbotMcpFailure>;
    readonly knowledgeRead: (
      scope: McpInvocationScope,
      input: OpenbotKnowledgeGetInput,
    ) => Effect.Effect<OpenbotKnowledge, OpenbotMcpFailure>;
    readonly knowledgeWrite: (
      scope: McpInvocationScope,
      input: OpenbotMcpKnowledgeWriteInput,
    ) => Effect.Effect<OpenbotKnowledge, OpenbotMcpFailure>;
    readonly knowledgeDelete: (
      scope: McpInvocationScope,
      input: OpenbotKnowledgeDeleteInput,
    ) => Effect.Effect<void, OpenbotMcpFailure>;
    readonly startThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpStartThreadInput,
    ) => Effect.Effect<OpenbotMcpStartThreadResult, OpenbotMcpFailure>;
    readonly sendToThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpSendToThreadInput,
    ) => Effect.Effect<OpenbotMcpPeerResult, OpenbotMcpFailure>;
    readonly listThreads: (
      scope: McpInvocationScope,
      input: OpenbotMcpListThreadsInput,
    ) => Effect.Effect<OpenbotMcpListThreadsResult, OpenbotMcpFailure>;
    readonly snoozeThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpSnoozeThreadInput,
    ) => Effect.Effect<OpenbotMcpThreadControlResult, OpenbotMcpFailure>;
    readonly wakeThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpThreadControlInput,
    ) => Effect.Effect<OpenbotMcpThreadControlResult, OpenbotMcpFailure>;
    readonly cancelThread: (
      scope: McpInvocationScope,
      input: OpenbotMcpThreadControlInput,
    ) => Effect.Effect<OpenbotMcpThreadControlResult, OpenbotMcpFailure>;
    readonly setModel: (
      scope: McpInvocationScope,
      input: OpenbotMcpSetModelInput,
    ) => Effect.Effect<OpenbotMcpThreadControlResult, OpenbotMcpFailure>;
    readonly createChat: (
      scope: McpInvocationScope,
      input: OpenbotMcpCreateChatInput,
    ) => Effect.Effect<OpenbotChannel, OpenbotMcpFailure>;
    readonly updateChat: (
      scope: McpInvocationScope,
      input: OpenbotMcpUpdateChatInput,
    ) => Effect.Effect<OpenbotChannel, OpenbotMcpFailure>;
    readonly updateInstructions: (
      scope: McpInvocationScope,
      input: OpenbotMcpUpdateInstructionsInput,
    ) => Effect.Effect<OpenbotThreadContext, OpenbotMcpFailure>;
  }
>()("t3/mcp/toolkits/openbot/OpenbotMcpService") {}

function failure(code: OpenbotMcpFailure["code"], message: string): OpenbotMcpFailure {
  return new OpenbotMcpFailure({ code, message });
}

/**
 * The service speaks in domain error codes; the agent-facing surface has its
 * own smaller vocabulary. Anything an agent can act on (retry a stale write,
 * pick a different target, stop nesting) keeps its own code; the rest is an
 * opaque `operation_failed` so a tool description never promises a recovery
 * that does not exist.
 */
function toFailure(error: OpenbotError): OpenbotMcpFailure {
  switch (error.code) {
    case "project_not_found":
    case "knowledge_not_found":
    case "channel_not_found":
    case "request_not_found":
      return failure("not_found", error.message);
    case "nesting_not_allowed":
      return failure("nesting_not_allowed", error.message);
    case "knowledge_conflict":
    case "profile_conflict":
    case "context_conflict":
    case "peer_request_invalid":
      return failure("request_conflict", error.message);
    default:
      return failure("operation_failed", error.message);
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const channels = yield* OpenbotChannelService;
  const questions = yield* OpenbotQuestionService;

  const record = (
    scope: McpInvocationScope,
    input: {
      readonly kind: "message" | "silence";
      readonly text: string;
      readonly replyToId: string | undefined;
      readonly clientRequestId: string | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const recorded = yield* channels
        .recordDelivery({
          threadId: scope.threadId,
          kind: input.kind,
          text: input.text,
          replyToId: input.replyToId,
          requestKey: `${input.kind}:${encodeURIComponent(requestKey)}`,
        })
        .pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "OpenbotNoActiveRunError":
                return failure(
                  "no_active_run",
                  "This thread has no active turn, so nothing can be delivered right now.",
                );
              case "OpenbotInvalidReplyTargetError":
                return failure(
                  "invalid_reply_target",
                  `replyToMessageId ${error.replyToId} is not a message in this channel. Use an incoming message id from your context or a deliveryId you received from openbot_send_message, or omit it for a general message.`,
                );
              case "OpenbotDeliveryConflictError":
                return failure("request_conflict", error.message);
              case "OpenbotError":
                return error.code === "channel_not_found"
                  ? failure("not_a_channel", "This thread is not an OpenBot channel.")
                  : toFailure(error);
            }
          }),
        );
      return {
        deliveryId: recorded.delivery.id,
        channelId: recorded.delivery.channelId,
        runId: recorded.delivery.runId,
        kind: recorded.delivery.kind,
        replyTo: recorded.delivery.replyTo,
        deliveredInRun: recorded.deliveredInRun,
      } satisfies OpenbotMcpDeliveryResult;
    });

  const ownChannel = Effect.fn(function* (scope: McpInvocationScope) {
    const channel = yield* channels
      .channelForThread(scope.threadId)
      .pipe(Effect.mapError(toFailure));
    if (channel === undefined)
      return yield* failure("not_a_channel", "This tool requires an OpenBot main thread.");
    return channel;
  });

  /** Chat controls address the calling chat unless the agent names another one. */
  const targetChannelId = Effect.fn(function* (
    scope: McpInvocationScope,
    channelId: OpenbotChannelId | undefined,
  ) {
    if (channelId !== undefined) return channelId;
    return (yield* ownChannel(scope)).id;
  });

  /**
   * The same target, resolved to the stored channel. A profile edit merges the
   * fields the agent omitted with the ones on disk, so it has to read first;
   * the caller's own channel is already loaded, and any other one comes back
   * through the view.
   */
  const targetChannel = Effect.fn(function* (
    scope: McpInvocationScope,
    channelId: OpenbotChannelId | undefined,
  ) {
    if (channelId === undefined) return yield* ownChannel(scope);
    const view = yield* channels.getView(channelId).pipe(Effect.mapError(toFailure));
    return view.channel;
  });

  /**
   * The control operations return the stored channel, which carries no run
   * status; the view is the one place both status and snooze are derived from
   * the v2 projection, so it is read back after the write.
   */
  const controlResult = Effect.fn(function* (channelId: OpenbotChannelId) {
    const view = yield* channels.getView(channelId).pipe(Effect.mapError(toFailure));
    return {
      channelId: view.channel.id,
      threadId: view.channel.threadId,
      status: view.status,
      snoozedUntil: view.snoozedUntil,
      modelSelection: view.channel.modelSelection,
    } satisfies OpenbotMcpThreadControlResult;
  });

  const getContext = Effect.fn(function* (scope: McpInvocationScope) {
    const channel = yield* ownChannel(scope);
    return yield* channels.getContext(channel.id).pipe(Effect.mapError(toFailure));
  });
  const updateKnowledge = Effect.fn(function* (
    scope: McpInvocationScope,
    input: OpenbotMcpUpdateKnowledgeInput,
  ) {
    const channel = yield* ownChannel(scope);
    const current = yield* getContext(scope);
    return yield* channels
      .updateContext({
        channelId: channel.id,
        expectedRevision: input.expectedRevision,
        instructions: current.instructions,
        knowledge: input.knowledge,
      })
      .pipe(Effect.mapError(toFailure));
  });

  const knowledgeWrite = Effect.fn(function* (
    _scope: McpInvocationScope,
    input: OpenbotMcpKnowledgeWriteInput,
  ) {
    const links = input.projectIds === undefined ? {} : { projectIds: input.projectIds };
    const owner =
      input.ownerProjectId === undefined ? {} : { ownerProjectId: input.ownerProjectId };
    if (input.knowledgeId === undefined) {
      return yield* channels
        .createKnowledge({
          title: input.title,
          body: input.body,
          ...owner,
          ...links,
          ...(input.clientRequestId === undefined
            ? {}
            : {
                commandId: CommandId.make(
                  `command:openbot:knowledge:${encodeURIComponent(input.clientRequestId)}`,
                ),
              }),
        })
        .pipe(Effect.mapError(toFailure));
    }
    if (input.expectedRevision === undefined) {
      return yield* failure(
        "request_conflict",
        "Updating a knowledge entry needs expectedRevision. Read the entry with openbot_knowledge_read, merge your change into its body, and retry with the revision it returned.",
      );
    }
    return yield* channels
      .updateKnowledge({
        knowledgeId: input.knowledgeId,
        expectedRevision: input.expectedRevision,
        title: input.title,
        body: input.body,
        ...owner,
        ...links,
      })
      .pipe(Effect.mapError(toFailure));
  });

  const startThread = Effect.fn(function* (
    scope: McpInvocationScope,
    input: OpenbotMcpStartThreadInput,
  ) {
    const parent = yield* ownChannel(scope);
    const started = yield* channels
      .startThread({
        parentChannelId: parent.id,
        title: input.title,
        task: input.task,
        clientRequestId: input.clientRequestId,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        originThreadId: scope.threadId,
      })
      .pipe(Effect.mapError(toFailure));
    return {
      channelId: started.channel.id,
      threadId: started.channel.threadId,
      requestId: started.requestId,
      created: started.created,
    } satisfies OpenbotMcpStartThreadResult;
  });

  return OpenbotMcpService.of({
    askQuestion: (scope, input) =>
      questions
        .ask({
          threadId: scope.threadId,
          questions: input.questions,
          clientRequestId: input.clientRequestId,
        })
        .pipe(
          Effect.mapError((error) => {
            switch (error.code) {
              case "no_active_run":
                return failure("no_active_run", error.message);
              case "conflict":
                return failure("request_conflict", error.message);
              default:
                return failure("operation_failed", error.message);
            }
          }),
        ),
    prepareFile: (scope, input) =>
      channels.prepareFile(scope.threadId, input.path).pipe(Effect.mapError(toFailure)),
    getContext,
    updateKnowledge,
    requestThread: (scope, input) =>
      channels.requestThread(scope.threadId, input).pipe(Effect.mapError(toFailure)),
    replyToThread: (scope, input) =>
      channels.replyToThread(scope.threadId, input).pipe(Effect.mapError(toFailure)),
    sendMessage: (scope, input) =>
      record(scope, {
        kind: "message",
        text: input.text,
        replyToId: input.replyToMessageId,
        clientRequestId: input.clientRequestId,
      }),
    skipReply: (scope, input) =>
      record(scope, {
        kind: "silence",
        text: input.reason ?? "",
        replyToId: undefined,
        clientRequestId: undefined,
      }),
    listProjects: () => channels.listProjects.pipe(Effect.mapError(toFailure)),
    createProject: (_scope, input) =>
      channels
        .createProject({
          name: input.name,
          ...(input.icon === undefined ? {} : { icon: input.icon }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.attachedPath === undefined ? {} : { attachedPath: input.attachedPath }),
          commandId: CommandId.make(
            `command:openbot:project:${encodeURIComponent(input.clientRequestId)}`,
          ),
        })
        .pipe(Effect.mapError(toFailure)),
    updateProject: (_scope, input) =>
      channels.updateProject(input).pipe(Effect.mapError(toFailure)),
    searchIcons: (_scope, input) => Effect.succeed(searchOpenbotIcons(input.query, input.limit)),
    knowledgeList: (_scope, input) =>
      channels.listKnowledge(input).pipe(Effect.mapError(toFailure)),
    knowledgeRead: (_scope, input) =>
      channels.getKnowledge(input.knowledgeId).pipe(Effect.mapError(toFailure)),
    knowledgeWrite,
    knowledgeDelete: (_scope, input) =>
      channels.deleteKnowledge(input).pipe(Effect.mapError(toFailure)),
    startThread,
    sendToThread: (scope, input) =>
      channels.sendToThread(scope.threadId, input).pipe(Effect.mapError(toFailure)),
    listThreads: (scope, input) =>
      channels
        .listThreads({ ...input, callerThreadId: scope.threadId })
        .pipe(Effect.mapError(toFailure)),
    snoozeThread: Effect.fn(function* (scope, input) {
      const channelId = yield* targetChannelId(scope, input.channelId);
      yield* channels.snooze({ channelId, until: input.until }).pipe(Effect.mapError(toFailure));
      return yield* controlResult(channelId);
    }),
    wakeThread: Effect.fn(function* (scope, input) {
      const channelId = yield* targetChannelId(scope, input.channelId);
      yield* channels.wake(channelId).pipe(Effect.mapError(toFailure));
      return yield* controlResult(channelId);
    }),
    cancelThread: Effect.fn(function* (scope, input) {
      const channelId = yield* targetChannelId(scope, input.channelId);
      yield* channels.cancel(channelId).pipe(Effect.mapError(toFailure));
      return yield* controlResult(channelId);
    }),
    setModel: Effect.fn(function* (scope, input) {
      const channelId = yield* targetChannelId(scope, input.channelId);
      yield* channels
        .setModel({ channelId, modelSelection: input.modelSelection })
        .pipe(Effect.mapError(toFailure));
      return yield* controlResult(channelId);
    }),
    // No parent: a chat created here is top-level, like New chat in the sidebar.
    createChat: (_scope, input) =>
      channels
        .create({
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          commandId: CommandId.make(
            `command:openbot:chat:${encodeURIComponent(input.clientRequestId)}`,
          ),
        })
        .pipe(Effect.mapError(toFailure)),
    updateChat: Effect.fn(function* (scope, input) {
      const current = yield* targetChannel(scope, input.channelId);
      return yield* channels
        .update({
          channelId: current.id,
          name: input.name ?? current.name,
          // Avatars are a person's choice; the agent has no way to set one.
          avatar: current.avatar,
          description: input.description ?? current.description,
          modelSelection: input.modelSelection ?? current.modelSelection,
          expectedRevision: input.expectedRevision,
        })
        .pipe(Effect.mapError(toFailure));
    }),
    updateInstructions: Effect.fn(function* (scope, input) {
      const channelId = yield* targetChannelId(scope, input.channelId);
      const current = yield* channels.getContext(channelId).pipe(Effect.mapError(toFailure));
      return yield* channels
        .updateContext({
          channelId,
          expectedRevision: input.expectedRevision,
          instructions: input.instructions,
          // Instructions and knowledge share one revision; carry the other side
          // through unchanged so an edit here cannot drop remembered facts.
          knowledge: current.knowledge,
        })
        .pipe(Effect.mapError(toFailure));
    }),
  });
});

export const layer = Layer.effect(OpenbotMcpService, make);
