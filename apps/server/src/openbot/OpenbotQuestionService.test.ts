import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { OpenbotChannelService } from "./OpenbotChannelService.ts";
import { makeOpenbotTestLayer } from "./OpenbotChannelService.testkit.ts";
import {
  layer as openbotQuestionServiceLayer,
  OpenbotQuestionService,
} from "./OpenbotQuestionService.ts";

const OpenbotLayer = makeOpenbotTestLayer("t3-openbot-question-service-");
const TestLayer = Layer.merge(
  OpenbotLayer,
  openbotQuestionServiceLayer.pipe(Layer.provide(OpenbotLayer)),
);

const questions = [
  {
    header: "Format",
    question: "How should I write it up?",
    options: [{ label: "Bullet list" }, { label: "Prose", description: "Full paragraphs" }],
  },
] as const;

/** A channel with one message in flight, so a run is active to ask from. */
const channelWithActiveRun = Effect.fn(function* (name: string) {
  const channels = yield* OpenbotChannelService;
  const channel = yield* channels.create({ name });
  yield* channels.send({
    channelId: channel.id,
    text: "Write up the meeting",
    messageId: MessageId.make(`message:openbot-question-test:${name}`),
  });
  return channel;
});

it.layer(TestLayer)("OpenbotQuestionService", (it) => {
  it.effect("records one pending message-mode question per client request id", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const service = yield* OpenbotQuestionService;
      const channel = yield* channelWithActiveRun("ask-once");

      const asked = yield* service.ask({
        threadId: channel.threadId,
        questions,
        clientRequestId: "format-question",
      });
      assert.equal(asked.threadId, channel.threadId);

      const projection = yield* threads.getThreadProjection(channel.threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === asked.requestId,
      );
      assert.equal(request?.kind, "user_input");
      assert.equal(request?.status, "pending");
      assert.deepEqual(request?.responseCapability, { type: "message" });
      const item = projection.turnItems.find(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === asked.requestId,
      );
      if (item?.type !== "user_input_request") throw new Error("Expected a question turn item");
      assert.equal(item.responseMode, "message");
      assert.deepEqual(item.questions, [
        {
          id: "1",
          header: "Format",
          question: "How should I write it up?",
          // An option without a description repeats its label, as the UI hides
          // a description equal to its label.
          options: [
            { label: "Bullet list", description: "Bullet list" },
            { label: "Prose", description: "Full paragraphs" },
          ],
        },
      ]);
      // The question waits on its own, so it must not hold the run open.
      assert.equal(projection.nodes.find((node) => node.id === item.nodeId)?.countsForRun, false);

      const retry = yield* service.ask({
        threadId: channel.threadId,
        questions,
        clientRequestId: "format-question",
      });
      assert.equal(retry.requestId, asked.requestId);
      const afterRetry = yield* threads.getThreadProjection(channel.threadId);
      assert.equal(
        afterRetry.runtimeRequests.filter((candidate) => candidate.kind === "user_input").length,
        1,
      );
    }),
  );

  it.effect("resolves the question and queues the answer as a user message", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const service = yield* OpenbotQuestionService;
      const channel = yield* channelWithActiveRun("answer");

      const asked = yield* service.ask({
        threadId: channel.threadId,
        questions,
        clientRequestId: "format-question",
      });
      yield* threads.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("command:openbot-question-test:respond"),
        threadId: channel.threadId,
        requestId: asked.requestId,
        answers: { "1": "Bullet list" },
      });

      const projection = yield* threads.getThreadProjection(channel.threadId);
      assert.equal(
        projection.runtimeRequests.find((candidate) => candidate.id === asked.requestId)?.status,
        "resolved",
      );
      const answerMessageId = MessageId.make(`async-answer:${asked.requestId}`);
      const answer = projection.messages.find((message) => message.id === answerMessageId);
      assert.equal(answer?.role, "user");
      assert.equal(answer?.text, "How should I write it up?\nBullet list");
      // The answer wakes the thread through the ordinary queue, so the agent
      // reads it in its next turn rather than mid-turn.
      assert.isTrue(
        projection.runs.some(
          (run) => run.status === "queued" && run.userMessageId === answerMessageId,
        ),
      );
    }),
  );

  it.effect("refuses to ask when the thread has no active turn", () =>
    Effect.gen(function* () {
      const channels = yield* OpenbotChannelService;
      const service = yield* OpenbotQuestionService;
      const channel = yield* channels.create({ name: "idle" });

      const error = yield* service
        .ask({ threadId: channel.threadId, questions, clientRequestId: "format-question" })
        .pipe(Effect.flip);
      assert.equal(error.code, "no_active_run");
    }),
  );
});
