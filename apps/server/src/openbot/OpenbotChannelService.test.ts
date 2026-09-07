import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OpenbotChannelId,
  OpenbotDeliveryId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderTurnInstructionsV2 } from "../orchestration-v2/TurnInstructions.ts";
import {
  buildIncomingMessages,
  deriveChannelStatus,
  OpenbotChannelService,
  openbotTurnInstructions,
  resolveReplyTarget,
} from "./OpenbotChannelService.ts";
import {
  completeRun,
  makeOpenbotTestLayer,
  openbotModelSelection as modelSelection,
  watchPromotions,
} from "./OpenbotChannelService.testkit.ts";

const TestLayer = makeOpenbotTestLayer("t3-openbot-channel-service-");

it.layer(TestLayer)("OpenbotChannelService", (it) => {
  it.effect("creates once and saves profiles without overwriting context or stale edits", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const input = {
        name: "Files bot",
        avatar: "🌱",
        description: "Creates useful documents",
        commandId: CommandId.make("create-profile-test"),
      };
      const [first, retry] = yield* Effect.all([service.create(input), service.create(input)], {
        concurrency: 2,
      });
      assert.equal(first.id, retry.id);
      assert.equal((yield* service.list).channels.filter((item) => item.id === first.id).length, 1);
      const context = yield* service.updateContext({
        channelId: first.id,
        expectedRevision: 0,
        instructions: "Keep useful files",
        knowledge: "Preserve this note",
      });
      const model = { ...modelSelection, model: "custom-model" };
      const updated = yield* service.update({
        channelId: first.id,
        name: "Document bot",
        avatar: "📄",
        description: "Writes documents",
        modelSelection: model,
        expectedRevision: 0,
      });
      assert.equal(updated.revision, 1);
      assert.equal((yield* service.getView(first.id)).channel.name, "Document bot");
      assert.deepEqual(yield* service.getContext(first.id), context);
      const stale = yield* service
        .update({
          channelId: first.id,
          name: "Stale edit",
          avatar: "",
          description: "",
          modelSelection,
          expectedRevision: 0,
        })
        .pipe(Effect.flip);
      assert.equal(stale.code, "profile_conflict");
      const sent = yield* service.send({ channelId: first.id, text: "Use the selected model" });
      const orchestrator = yield* OrchestratorV2;
      const projection = yield* orchestrator.getThreadProjection(first.threadId);
      assert.equal(
        projection.runs.find((run) => run.id === sent.runId)?.modelSelection.model,
        "custom-model",
      );
    }),
  );

  it.effect("claims uploaded bytes durably and leaves accepted files untouched on retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const service = yield* OpenbotChannelService;
      const channel = yield* service.create({ name: "Upload intake" });
      const pendingId = createPendingAttachmentId(".txt");
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(path.join(config.attachmentsDir, `${pendingId}.txt`), "uploaded");
      const file = {
        type: "file",
        id: pendingId,
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
      };
      const input = {
        channelId: channel.id,
        text: "Read the file",
        attachments: [file],
        messageId: MessageId.make("message-upload-intake"),
      };
      yield* service.send(input);
      const view = yield* service.getView(channel.id);
      const attachment = view.messages[0]?.attachments[0];
      if (attachment === undefined) throw new Error("Expected claimed attachment");
      assert.notEqual(attachment.id, pendingId);
      const stored = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (stored === null) throw new Error("Expected attachment path");
      assert.equal(yield* fs.readFileString(stored), "uploaded");
      yield* fs.writeFileString(stored, "agent edited the file");
      yield* service.send(input);
      assert.equal(yield* fs.readFileString(stored), "agent edited the file");
    }),
  );

  it.effect(
    "retains file references and deduplicates retries including attachment-only messages",
    () =>
      Effect.gen(function* () {
        const service = yield* OpenbotChannelService;
        const channel = yield* service.create({ name: "Attachment test" });
        const file = {
          type: "file",
          id: "thread-file-00000000-0000-4000-8000-000000000001-txt",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        };
        const input = {
          channelId: channel.id,
          text: "",
          attachments: [file],
          messageId: MessageId.make("message-attachment-test"),
        };
        const sent = yield* service.send(input);
        const retry = yield* service.send(input);
        assert.equal(sent.runId, retry.runId);
        const view = yield* service.getView(channel.id);
        assert.equal(view.messages.length, 1);
        assert.deepEqual(view.messages[0]?.attachments, [file]);
        const changed = yield* service
          .send({ ...input, attachments: [{ ...file, name: "changed.txt" }] })
          .pipe(Effect.flip);
        assert.equal(changed.code, "orchestration_error");
        const empty = yield* service.send({ channelId: channel.id, text: " " }).pipe(Effect.flip);
        assert.match(empty.message, /Add a message or a file/);
      }),
  );

  it.effect("groups messages sent during an active run into one queued run, in order", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const channel = yield* channels.create({ name: "Work" });

      // A single message with nothing active starts immediately.
      const first = yield* channels.send({
        channelId: channel.id,
        text: "first",
        messageId: MessageId.make("message:openbot-test:first"),
      });
      assert.equal(first.delivery, "started");

      const followUps = yield* Effect.all(
        ["second", "third", "fourth"].map((text) =>
          channels.send({
            channelId: channel.id,
            text,
            messageId: MessageId.make(`message:openbot-test:${text}`),
          }),
        ),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        followUps.map((send) => send.delivery),
        ["queued", "queued", "queued"],
      );
      const queuedRunIds = new Set(followUps.map((send) => send.runId));
      assert.equal(queuedRunIds.size, 1, "follow-ups share one queued run");

      const projection = yield* orchestrator.getThreadProjection(channel.threadId);
      const active = projection.runs.filter(
        (run) => run.status === "starting" || run.status === "running",
      );
      assert.equal(active.length, 1, "exactly one active root run");
      assert.equal(projection.runs.filter((run) => run.status === "queued").length, 1);
      // Every message keeps its own identity and text; none are merged away.
      // Concurrent sends are serialized by the thread lock, so arrival order is
      // whichever order the lock granted; the ids and run ownership are fixed.
      assert.deepEqual(
        projection.messages
          .map((message) => [message.id, message.text, message.runId])
          .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
        [
          ["message:openbot-test:first", "first", first.runId],
          ["message:openbot-test:fourth", "fourth", followUps[0]!.runId],
          ["message:openbot-test:second", "second", followUps[0]!.runId],
          ["message:openbot-test:third", "third", followUps[0]!.runId],
        ],
      );
      // Grouped messages carry strictly increasing arrival stamps even on a
      // frozen clock, so the group order is never ambiguous.
      const grouped = projection.messages.filter((message) => message.runId !== first.runId);
      const stamps = grouped.map((message) => DateTime.toEpochMillis(message.createdAt));
      assert.deepEqual(
        stamps,
        stamps.toSorted((left, right) => left - right),
      );
      assert.equal(new Set(stamps).size, stamps.length, "no two grouped messages share a stamp");

      const view = yield* channels.getView(channel.id);
      assert.equal(view.status, "working");
      assert.deepEqual(
        view.messages
          .map((message) => [message.text, message.state])
          .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
        [
          ["first", "working"],
          ["fourth", "pending"],
          ["second", "pending"],
          ["third", "pending"],
        ],
      );
    }),
  );

  it.effect(
    "promotes the group as one turn with a turn item per message, and queues later input separately",
    () =>
      Effect.gen(function* () {
        const channels = yield* OpenbotChannelService;
        const orchestrator = yield* OrchestratorV2;
        const channel = yield* channels.create({ name: "Life" });
        const idA = MessageId.make("message:openbot-group:a");
        const idB = MessageId.make("message:openbot-group:b");
        const idC = MessageId.make("message:openbot-group:c");
        // Sequential sends: b and c arrive, in that order, while a is active.
        for (const messageId of [idA, idB, idC]) {
          yield* channels.send({ channelId: channel.id, text: messageId, messageId });
        }
        const promoted = yield* watchPromotions(channel.threadId);

        const before = yield* orchestrator.getThreadProjection(channel.threadId);
        const firstRun = before.runs.find((run) => run.userMessageId === idA);
        assert.isDefined(firstRun);

        // A delivery during the first run is visible immediately, before the
        // run ends, and an identical retry is not a second delivery.
        const delivered = yield* channels.recordDelivery({
          threadId: channel.threadId,
          kind: "message",
          text: "Hello from the first turn",
          replyToId: undefined,
          requestKey: "reply-1",
        });
        assert.equal(delivered.delivery.runId, firstRun.id);
        assert.equal(delivered.delivery.replyTo, null);
        const duringRun = yield* channels.getView(channel.id);
        assert.equal(duringRun.status, "working");
        assert.deepEqual(
          duringRun.deliveries.map((delivery) => delivery.id),
          [delivered.delivery.id],
        );
        const retried = yield* channels.recordDelivery({
          threadId: channel.threadId,
          kind: "message",
          text: "Hello from the first turn",
          replyToId: undefined,
          requestKey: "reply-1",
        });
        assert.equal(retried.deliveredInRun, 1);
        assert.equal(retried.delivery.id, delivered.delivery.id);

        yield* completeRun(channel.threadId, firstRun);
        const promotedRunId = yield* Queue.take(promoted);
        const afterFirst = yield* orchestrator.getThreadProjection(channel.threadId);
        const groupRun = afterFirst.runs.find((run) => run.userMessageId === idB);
        assert.isDefined(groupRun);
        assert.equal(promotedRunId, groupRun.id);
        assert.equal(groupRun.status, "starting");
        assert.deepEqual(
          afterFirst.turnItems
            .filter((item) => item.type === "user_message" && item.runId === groupRun.id)
            .toSorted((left, right) => left.ordinal - right.ordinal)
            .map((item) => (item.type === "user_message" ? item.messageId : null)),
          [idB, idC],
          "each grouped message materializes its own turn item in arrival order",
        );

        // A message arriving after promotion cannot join the starting run: it
        // queues a fresh run behind it.
        const late = yield* channels.send({
          channelId: channel.id,
          text: "late",
          messageId: MessageId.make("message:openbot-group:late"),
        });
        assert.equal(late.delivery, "queued");
        assert.notEqual(late.runId, groupRun.id);

        // Replaying the same send command is idempotent: no duplicate message.
        const replay = yield* channels.send({
          channelId: channel.id,
          text: "late",
          messageId: MessageId.make("message:openbot-group:late"),
          commandId: CommandId.make("command:openbot:send:message:openbot-group:late"),
        });
        assert.equal(replay.runId, late.runId);
        const afterReplay = yield* orchestrator.getThreadProjection(channel.threadId);
        assert.equal(afterReplay.messages.filter((message) => message.text === "late").length, 1);

        // The group run ends with a direct reply to one message only.
        const direct = yield* channels.recordDelivery({
          threadId: channel.threadId,
          kind: "message",
          text: "Answering b specifically",
          replyToId: idB,
          requestKey: "reply-b",
        });
        assert.deepEqual(direct.delivery.replyTo, { type: "message", messageId: idB });
        yield* completeRun(channel.threadId, groupRun);
        yield* Queue.take(promoted);
        const lateRun = (yield* orchestrator.getThreadProjection(channel.threadId)).runs.find(
          (run) => run.id === late.runId,
        );
        assert.isDefined(lateRun);
        yield* completeRun(channel.threadId, lateRun);

        const view = yield* channels.getView(channel.id);
        assert.deepEqual(
          view.messages.map((message) => [message.text, message.state, message.outcome]),
          [
            [idA, "handled", "replied"],
            [idB, "handled", "replied"],
            [idC, "handled", "no_reply"],
            ["late", "handled", "no_reply"],
          ],
          "incoming messages are tracked independently of how many replies were sent",
        );
        assert.equal(view.status, "idle");

        const stale = yield* channels
          .recordDelivery({
            threadId: channel.threadId,
            kind: "message",
            text: "too late",
            replyToId: undefined,
            requestKey: "late",
          })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "OpenbotNoActiveRunError");
      }),
  );

  it.effect("scopes reply targets to the calling channel and keeps retries honest", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const alpha = yield* channels.create({ name: "Alpha" });
      const beta = yield* channels.create({ name: "Beta" });
      const alphaMessage = MessageId.make("message:openbot-scope:alpha");
      const betaMessage = MessageId.make("message:openbot-scope:beta");
      yield* channels.send({ channelId: alpha.id, text: "alpha asks", messageId: alphaMessage });
      yield* channels.send({ channelId: beta.id, text: "beta asks", messageId: betaMessage });

      const rejected = (replyToId: string, requestKey: string) =>
        channels
          .recordDelivery({
            threadId: alpha.threadId,
            kind: "message",
            text: "leak?",
            replyToId,
            requestKey,
          })
          .pipe(Effect.flip);
      // Another channel's message, an unknown id, and a silence record are
      // all rejected without inserting anything.
      assert.equal((yield* rejected(betaMessage, "x1"))._tag, "OpenbotInvalidReplyTargetError");
      assert.equal((yield* rejected("message:nope", "x2"))._tag, "OpenbotInvalidReplyTargetError");
      const skipped = yield* channels.recordDelivery({
        threadId: alpha.threadId,
        kind: "silence",
        text: "",
        replyToId: undefined,
        requestKey: "skip",
      });
      assert.equal(
        (yield* rejected(skipped.delivery.id, "x3"))._tag,
        "OpenbotInvalidReplyTargetError",
      );
      assert.equal((yield* channels.getView(alpha.id)).deliveries.length, 1);

      // Own message and own prior delivery are valid targets.
      const toMessage = yield* channels.recordDelivery({
        threadId: alpha.threadId,
        kind: "message",
        text: "to the message",
        replyToId: alphaMessage,
        requestKey: "r1",
      });
      assert.deepEqual(toMessage.delivery.replyTo, { type: "message", messageId: alphaMessage });
      const toDelivery = yield* channels.recordDelivery({
        threadId: alpha.threadId,
        kind: "message",
        text: "to my own earlier message",
        replyToId: toMessage.delivery.id,
        requestKey: "r2",
      });
      assert.deepEqual(toDelivery.delivery.replyTo, {
        type: "delivery",
        deliveryId: toMessage.delivery.id,
      });
      // A delivery from another channel is not a valid target either.
      const betaDelivery = yield* channels.recordDelivery({
        threadId: beta.threadId,
        kind: "message",
        text: "beta reply",
        replyToId: undefined,
        requestKey: "b1",
      });
      assert.equal(
        (yield* rejected(betaDelivery.delivery.id, "x4"))._tag,
        "OpenbotInvalidReplyTargetError",
      );

      // A retry of the same request key must not change the recorded target.
      const conflict = yield* channels
        .recordDelivery({
          threadId: alpha.threadId,
          kind: "message",
          text: "to the message",
          replyToId: undefined,
          requestKey: "r1",
        })
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "OpenbotDeliveryConflictError");
      const view = yield* channels.getView(alpha.id);
      assert.equal(view.deliveries.filter((delivery) => delivery.kind === "silence").length, 1);
      assert.deepEqual(
        view.deliveries
          .filter((delivery) => delivery.kind === "message")
          .map((delivery) => [delivery.text, delivery.replyTo]),
        [
          ["to the message", { type: "message", messageId: alphaMessage }],
          ["to my own earlier message", { type: "delivery", deliveryId: toMessage.delivery.id }],
        ],
      );
    }),
  );

  it.effect("preserves context and rejects concurrent stale writes", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const instructions = yield* ProviderTurnInstructionsV2;
      const channel = yield* channels.create({ name: "Context" });
      const empty = yield* channels.getContext(channel.id);
      assert.equal(empty.revision, 0);
      const results = yield* Effect.all(
        [
          channels
            .updateContext({
              channelId: channel.id,
              instructions: "Read only.",
              knowledge: "Snapshot A",
              expectedRevision: 0,
            })
            .pipe(Effect.result),
          channels
            .updateContext({
              channelId: channel.id,
              instructions: "Ask before writes.",
              knowledge: "Snapshot B",
              expectedRevision: 0,
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const saved = yield* channels.getContext(channel.id);
      assert.equal(saved.revision, 1);
      const prompt = yield* instructions.resolve({
        threadId: channel.threadId,
        runOrdinal: 30,
        messageCount: 1,
      });
      assert.include(prompt, saved.instructions);
      assert.include(prompt, saved.knowledge);
      const stale = yield* channels
        .updateContext({
          channelId: channel.id,
          instructions: "",
          knowledge: "overwrite",
          expectedRevision: 0,
        })
        .pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      assert.deepEqual(yield* channels.getContext(channel.id), saved);
    }),
  );

  it.effect("routes peer requests and replies once with scoped correlation", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const source = yield* channels.create({ name: "Peer A" });
      const target = yield* channels.create({ name: "Peer B" });
      const stranger = yield* channels.create({ name: "Peer C" });
      const input = {
        channelId: target.id,
        clientRequestId: "snapshot-1",
        text: "Compare the snapshot.",
      };
      const first = yield* channels.requestThread(source.threadId, input);
      assert.deepEqual(yield* channels.requestThread(source.threadId, input), first);
      const conflict = yield* channels
        .requestThread(source.threadId, { ...input, text: "Changed request" })
        .pipe(Effect.result);
      assert.equal(conflict._tag, "Failure");
      const targetProjection = yield* orchestrator.getThreadProjection(target.threadId);
      assert.equal(targetProjection.messages.length, 1);
      assert.equal(targetProjection.messages[0]?.peerMessage?.sourceThreadId, source.threadId);
      assert.equal(
        (yield* channels.getView(target.id)).messages.length,
        0,
        "peer requests are not user messages",
      );
      const wrongThread = yield* channels
        .replyToThread(stranger.threadId, { requestId: first.requestId, text: "forged" })
        .pipe(Effect.result);
      assert.equal(wrongThread._tag, "Failure");
      const reply = yield* channels.replyToThread(target.threadId, {
        requestId: first.requestId,
        text: "Stable.",
      });
      assert.deepEqual(
        yield* channels.replyToThread(target.threadId, {
          requestId: first.requestId,
          text: "Stable.",
        }),
        reply,
      );
      const changedReply = yield* channels
        .replyToThread(target.threadId, { requestId: first.requestId, text: "Different." })
        .pipe(Effect.result);
      assert.equal(changedReply._tag, "Failure");
      const sourceProjection = yield* orchestrator.getThreadProjection(source.threadId);
      assert.equal(sourceProjection.messages.length, 1);
      assert.equal(sourceProjection.messages[0]?.peerMessage?.type, "reply");
      assert.equal(sourceProjection.messages[0]?.peerMessage?.requestId, first.requestId);
    }),
  );

  it.effect("keeps channels on independent threads and injects instructions per channel", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const instructions = yield* ProviderTurnInstructionsV2;
      const orchestrator = yield* OrchestratorV2;
      const gamma = yield* channels.create({ name: "Gamma" });
      const delta = yield* channels.create({ name: "Delta" });
      assert.notEqual(gamma.threadId, delta.threadId);
      assert.equal(gamma.projectId, delta.projectId, "channels share the OpenBot project");

      yield* channels.send({ channelId: gamma.id, text: "only gamma" });
      const gammaProjection = yield* orchestrator.getThreadProjection(gamma.threadId);
      const deltaProjection = yield* orchestrator.getThreadProjection(delta.threadId);
      assert.equal(gammaProjection.messages.length, 1);
      assert.equal(deltaProjection.messages.length, 0);
      assert.equal(deltaProjection.runs.length, 0, "delta has no run from gamma's message");

      const single = yield* instructions.resolve({
        threadId: gamma.threadId,
        runOrdinal: 1,
        messageCount: 1,
      });
      assert.include(single, openbotTurnInstructions({ channelName: "Gamma", messageCount: 1 }));
      const grouped = yield* instructions.resolve({
        threadId: gamma.threadId,
        runOrdinal: 2,
        messageCount: 3,
      });
      assert.include(grouped, "This turn carries 3 messages");
      assert.notInclude(single, "This turn carries");
      const other = yield* instructions.resolve({
        threadId: ThreadId.make("thread:not-a-channel"),
        runOrdinal: 1,
        messageCount: 1,
      });
      assert.isUndefined(other);
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
        replyToId: undefined,
        requestKey: "stream-1",
      });
      // The view stream debounces bursts on the test clock.
      yield* TestClock.adjust("100 millis");
      assert.equal(yield* Queue.take(views), 1);
      yield* Fiber.interrupt(fiber);
    }),
  );
});

const now = DateTime.makeUnsafe(Date.UTC(2026, 8, 6));
const message = (
  id: string,
  runId: RunId | null,
  createdBy: OrchestrationV2ConversationMessage["createdBy"] = "user",
): OrchestrationV2ConversationMessage => ({
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
  createdBy,
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
const delivery = (
  id: string,
  runId: string,
  kind: "message" | "silence",
  replyTo: ReturnType<typeof resolveReplyTarget> = undefined,
) => ({
  id: OpenbotDeliveryId.make(id),
  channelId: OpenbotChannelId.make("c"),
  runId: RunId.make(runId),
  kind,
  text: id,
  replyTo: replyTo ?? null,
  createdAt: "2026-09-06T00:00:00.000Z",
});

it("derives message states and outcomes for grouped runs without a delivery table", () => {
  const projection = {
    thread: { id: ThreadId.make("t") },
    runs: [
      run("r1", "m1", "completed"),
      run("r2", "m2", "failed"),
      run("r3", "m3", "completed"),
      run("r4", "m5", "queued"),
    ],
    messages: [
      message("m1", RunId.make("r1")),
      message("m2", RunId.make("r2")),
      // m3 and m4 were grouped into r3; only m4 got a direct reply.
      message("m3", RunId.make("r3")),
      message("m4", RunId.make("r3")),
      message("m5", RunId.make("r4")),
    ],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const deliveries = [
    delivery("d1", "r1", "silence"),
    delivery("d2", "r3", "message", { type: "message", messageId: MessageId.make("m4") }),
  ];
  assert.deepEqual(
    buildIncomingMessages({ projection, deliveries }).map((entry) => [entry.state, entry.outcome]),
    [
      ["handled", "silent"],
      ["failed", "failed"],
      ["handled", "no_reply"],
      ["handled", "replied"],
      ["pending", null],
    ],
  );
  // A general message during the group run settles every grouped message.
  assert.deepEqual(
    buildIncomingMessages({
      projection,
      deliveries: [...deliveries, delivery("d3", "r3", "message")],
    })
      .slice(2, 4)
      .map((entry) => entry.outcome),
    ["replied", "replied"],
  );
  assert.equal(deriveChannelStatus(projection), "working");
  assert.equal(deriveChannelStatus({ ...projection, runs: [run("r2", "m2", "failed")] }), "failed");

  // Reply targets: accepted user messages and message deliveries only.
  assert.deepEqual(resolveReplyTarget({ replyToId: "m3", projection, deliveries }), {
    type: "message",
    messageId: MessageId.make("m3"),
  });
  assert.deepEqual(resolveReplyTarget({ replyToId: "d2", projection, deliveries }), {
    type: "delivery",
    deliveryId: OpenbotDeliveryId.make("d2"),
  });
  assert.isUndefined(resolveReplyTarget({ replyToId: "d1", projection, deliveries }));
  assert.isUndefined(resolveReplyTarget({ replyToId: "missing", projection, deliveries }));
  assert.isUndefined(
    resolveReplyTarget({
      replyToId: "agent-made",
      projection: {
        ...projection,
        messages: [message("agent-made", RunId.make("r1"), "agent")],
      },
      deliveries,
    }),
  );
});
