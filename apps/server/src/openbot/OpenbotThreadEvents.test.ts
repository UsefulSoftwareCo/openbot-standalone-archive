import { assert, it } from "@effect/vitest";
import { CommandId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderTurnInstructionsV2 } from "../orchestration-v2/TurnInstructions.ts";
import { OpenbotChannelService } from "./OpenbotChannelService.ts";
import { makeOpenbotTestLayer } from "./OpenbotChannelService.testkit.ts";

it.layer(makeOpenbotTestLayer("t3-openbot-thread-events-"))(
  "project thread system events",
  (it) => {
    it.effect(
      "persists UI creation without waking the parent and exposes the record to the model",
      () =>
        Effect.gen(function* () {
          const service = yield* OpenbotChannelService;
          const orchestrator = yield* OrchestratorV2;
          const instructions = yield* ProviderTurnInstructionsV2;
          const project = yield* service.createProject({
            name: "Garden",
            commandId: CommandId.make("garden"),
          });
          const parent = (yield* service.getView(project.mainChannelId)).channel;
          const input = {
            parentChannelId: parent.id,
            title: "Mulch research",
            clientRequestId: "mulch",
          };
          const child = yield* service.createChildChannel(input);
          yield* service.createChildChannel(input);
          const view = yield* service.getView(parent.id);
          assert.equal(view.events.length, 1);
          const event = view.events[0];
          assert.isDefined(event);
          assert.equal(event?.targetChannelId, child.id);
          const projection = yield* orchestrator.getThreadProjection(parent.threadId);
          assert.equal(projection.runs.length, 0);
          assert.equal(projection.messages.length, 0);
          assert.isTrue(
            projection.turnItems.some(
              (item) => item.id === event?.id && item.type === "thread_created",
            ),
          );
          const prompt = yield* instructions.resolve({
            threadId: parent.threadId,
            runOrdinal: 1,
            messageCount: 1,
          });
          assert.include(prompt ?? "", child.id);
          assert.include(prompt ?? "", "Mulch research");
          const invalid = yield* orchestrator
            .dispatch({
              type: "thread.created.record",
              commandId: CommandId.make("invalid-duplicate"),
              parentThreadId: parent.threadId,
              parentRunId: null,
              parentNodeId: null,
              targetThreadId: child.threadId,
              targetRunId: RunId.make("missing-run"),
            })
            .pipe(Effect.flip);
          assert.include(String(invalid.cause), "does not belong");
        }),
    );
    it.effect("records agent-origin creation once and leaves standalone chats alone", () =>
      Effect.gen(function* () {
        const service = yield* OpenbotChannelService;
        const project = yield* service.createProject({
          name: "Kitchen",
          commandId: CommandId.make("kitchen"),
        });
        const parent = (yield* service.getView(project.mainChannelId)).channel;
        const input = {
          parentChannelId: parent.id,
          title: "Soup",
          task: "Compare vegetables",
          clientRequestId: "soup",
          originThreadId: parent.threadId,
        };
        const child = yield* service.startThread(input);
        yield* service.startThread(input);
        const view = yield* service.getView(parent.id);
        assert.equal(view.events.length, 1);
        assert.equal(view.events[0]?.targetChannelId, child.channel.id);
        const chat = yield* service.create({ name: "Standalone" });
        yield* service.create({ name: "Child", parentChannelId: chat.id });
        assert.deepEqual([...(yield* service.getView(chat.id)).events], []);
      }),
    );
  },
);
