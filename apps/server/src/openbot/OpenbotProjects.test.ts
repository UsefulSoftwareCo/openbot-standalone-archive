import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  OpenbotProjectId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderTurnInstructionsV2 } from "../orchestration-v2/TurnInstructions.ts";
import { ProjectService } from "../project/ProjectService.ts";
import {
  OPENBOT_PROJECTS_DIRNAME,
  OPENBOT_WORKSPACE_DIRNAME,
  OpenbotChannelService,
} from "./OpenbotChannelService.ts";
import { makeOpenbotTestLayer, openbotModelSelection } from "./OpenbotChannelService.testkit.ts";

const TestLayer = makeOpenbotTestLayer("t3-openbot-projects-");

it.layer(TestLayer)("OpenBot projects, child chats, and knowledge", (it) => {
  it.effect("leaves chats created before projects existed untouched", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const chat = yield* service.create({ name: "Standalone" });
      assert.equal(chat.parentChannelId, null);
      assert.equal(chat.openbotProjectId, null);
      assert.deepEqual([...(yield* service.listProjects).projects], []);
      assert.deepEqual([...(yield* service.listKnowledge({})).entries], []);
      const view = yield* service.getView(chat.id);
      assert.deepEqual([...view.pendingRequests], []);
      assert.equal(view.snoozedUntil, null);
    }),
  );

  it.effect("creates a managed project with its own working directory and main chat", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const projects = yield* ProjectService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = { name: "Recipes", commandId: CommandId.make("create-recipes") };
      const project = yield* service.createProject(input);

      assert.equal(project.workspace.kind, "managed");
      assert.isTrue(
        project.workspace.path.startsWith(
          path.join(config.stateDir, OPENBOT_WORKSPACE_DIRNAME, OPENBOT_PROJECTS_DIRNAME),
        ),
        "managed directories live inside the OpenBot workspace repository",
      );
      assert.isTrue(yield* fs.exists(project.workspace.path));
      const t3Project = yield* projects.getById(project.t3ProjectId);
      assert.equal(
        Option.isSome(t3Project) ? t3Project.value.workspaceRoot : null,
        project.workspace.path,
      );

      const main = (yield* service.getView(project.mainChannelId)).channel;
      assert.equal(main.name, "Recipes");
      assert.equal(main.projectId, project.t3ProjectId);
      assert.equal(main.openbotProjectId, project.id);
      assert.equal(main.parentChannelId, null);

      assert.deepEqual(yield* service.createProject(input), project, "a replay returns the first");
      assert.equal((yield* service.listProjects).projects.length, 1);
      const conflict = yield* service
        .createProject({ ...input, name: "Something else" })
        .pipe(Effect.flip);
      assert.equal(conflict.code, "profile_conflict");

      const renamed = yield* service.updateProject({
        projectId: project.id,
        expectedRevision: 0,
        name: "Meals",
      });
      assert.equal(renamed.name, "Meals");
      assert.equal((yield* service.getView(project.mainChannelId)).channel.name, "Meals");
      const stale = yield* service
        .updateProject({ projectId: project.id, expectedRevision: 0, name: "Stale" })
        .pipe(Effect.flip);
      assert.equal(stale.code, "profile_conflict");
      const missing = yield* service
        .getProject(OpenbotProjectId.make("openbot-project:nope"))
        .pipe(Effect.flip);
      assert.equal(missing.code, "project_not_found");
    }),
  );

  it.effect("attaches an existing folder and never initializes or moves it", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attached = path.join(config.stateDir, "attached-checkout");
      yield* fs.makeDirectory(attached, { recursive: true });
      yield* fs.writeFileString(path.join(attached, "README.md"), "hello");

      const project = yield* service.createProject({
        name: "Attached",
        attachedPath: attached,
        commandId: CommandId.make("create-attached"),
      });
      assert.deepEqual(project.workspace, { kind: "attached", path: attached });
      assert.deepEqual(
        [...(yield* fs.readDirectory(attached))].toSorted(),
        ["README.md"],
        "an attached folder gains no repository of its own",
      );
      assert.equal(
        (yield* service.getView(project.mainChannelId)).channel.openbotProjectId,
        project.id,
      );

      const notADirectory = yield* service
        .createProject({
          name: "File",
          attachedPath: path.join(attached, "README.md"),
          commandId: CommandId.make("create-file"),
        })
        .pipe(Effect.flip);
      assert.equal(notADirectory.code, "project_unavailable");
      const second = yield* service.createProject({
        name: "Again",
        attachedPath: attached,
        instructions: "Only the second bot knows this instruction.",
        commandId: CommandId.make("create-again"),
      });
      assert.notEqual(second.t3ProjectId, project.t3ProjectId);
      const secondMain = (yield* service.getView(second.mainChannelId)).channel;
      assert.equal(secondMain.openbotProjectId, second.id);
      const child = yield* service.create({ name: "Second child", parentChannelId: secondMain.id });
      assert.equal(child.openbotProjectId, second.id);
      const instructions = yield* ProviderTurnInstructionsV2;
      const firstMain = (yield* service.getView(project.mainChannelId)).channel;
      const firstPrompt = yield* instructions.resolve({
        threadId: firstMain.threadId,
        runOrdinal: 1,
        messageCount: 0,
      });
      const childPrompt = yield* instructions.resolve({
        threadId: child.threadId,
        runOrdinal: 1,
        messageCount: 0,
      });
      assert.notInclude(firstPrompt ?? "", second.instructions);
      assert.include(childPrompt ?? "", second.instructions);
      yield* service.deleteProject({
        projectId: project.id,
        commandId: CommandId.make("delete-attached"),
      });
      assert.equal(
        (yield* service.getView(second.mainChannelId)).channel.openbotProjectId,
        second.id,
      );
      assert.equal((yield* service.getView(child.id)).channel.openbotProjectId, second.id);
      assert.equal(yield* fs.readFileString(path.join(attached, "README.md")), "hello");
      const projects = yield* ProjectService;
      const deleted = yield* projects.getById(project.t3ProjectId);
      assert.isTrue(Option.isNone(deleted));
      const retained = yield* projects.getById(second.t3ProjectId);
      assert.isTrue(Option.isSome(retained));
    }),
  );

  it.effect("replays a create only for the same folder decision", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folderA = path.join(config.stateDir, "replay-a");
      const folderB = path.join(config.stateDir, "replay-b");
      yield* fs.makeDirectory(folderA, { recursive: true });
      yield* fs.makeDirectory(folderB, { recursive: true });
      const commandId = CommandId.make("create-replay");
      const first = yield* service.createProject({
        name: "Replay",
        attachedPath: folderA,
        commandId,
      });
      const same = yield* service.createProject({
        name: "Replay",
        attachedPath: folderA,
        commandId,
      });
      assert.equal(same.id, first.id);
      const otherFolder = yield* service
        .createProject({ name: "Replay", attachedPath: folderB, commandId })
        .pipe(Effect.flip);
      assert.equal(otherFolder.code, "profile_conflict");
      const managedInstead = yield* service
        .createProject({ name: "Replay", commandId })
        .pipe(Effect.flip);
      assert.equal(managedInstead.code, "profile_conflict");
    }),
  );

  it.effect("keeps the thread and the chat on the same model across repeated toggles", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const chat = yield* service.create({
        name: "Toggle",
        commandId: CommandId.make("create-toggle"),
      });
      const other = { ...openbotModelSelection, model: "gpt-5.4-mini" };
      for (const selection of [other, openbotModelSelection, other, openbotModelSelection, other]) {
        const updated = yield* service.setModel({ channelId: chat.id, modelSelection: selection });
        assert.equal(updated.modelSelection.model, selection.model);
        const projection = yield* orchestrator.getThreadProjection(chat.threadId);
        assert.equal(
          projection.thread.modelSelection.model,
          selection.model,
          "the T3 thread follows every toggle, not only the first of each value",
        );
      }
    }),
  );

  it.effect("keeps child chats one level deep inside the parent's workspace", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const project = yield* service.createProject({
        name: "Ops",
        commandId: CommandId.make("create-ops"),
        modelSelection: { ...openbotModelSelection, model: "custom-model" },
      });
      const parent = (yield* service.getView(project.mainChannelId)).channel;
      assert.equal(parent.modelSelection.model, "custom-model");

      const child = yield* service.create({ name: "Focused", parentChannelId: parent.id });
      assert.equal(child.parentChannelId, parent.id);
      assert.equal(child.projectId, parent.projectId, "a child shares the parent's workspace");
      assert.equal(child.openbotProjectId, project.id);
      assert.equal(child.modelSelection.model, "custom-model", "a child inherits the model");

      const nested = yield* service
        .create({ name: "Deeper", parentChannelId: child.id })
        .pipe(Effect.flip);
      assert.equal(nested.code, "nesting_not_allowed");
    }),
  );

  it.effect("starts a child chat and dispatches its task exactly once", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const parent = yield* service.create({ name: "Planner" });
      const input = {
        parentChannelId: parent.id,
        title: "Draft the memo",
        task: "Write the launch memo.",
        clientRequestId: "memo-1",
      };
      const started = yield* service.startThread(input);
      assert.isTrue(started.created);
      assert.equal(started.channel.parentChannelId, parent.id);

      const projection = yield* orchestrator.getThreadProjection(started.channel.threadId);
      assert.equal(projection.messages.length, 1);
      const message = projection.messages[0];
      assert.equal(message?.id, started.messageId);
      assert.include(message?.text ?? "", "Write the launch memo.");
      assert.equal(message?.peerMessage?.type, "request");
      assert.equal(message?.peerMessage?.sourceThreadId, parent.threadId);
      assert.equal(message?.peerMessage?.requestId, started.requestId);
      assert.equal(projection.runs.length, 1, "the task starts exactly one run");

      // The child's transcript shows who asked and what was asked, never the
      // internal routing envelope.
      const childView = yield* service.getView(started.channel.id);
      assert.equal(childView.messages.length, 1);
      assert.equal(childView.messages[0]?.origin?.kind, "peer_request");
      assert.equal(childView.messages[0]?.origin?.sourceName, "Planner");
      assert.equal(childView.messages[0]?.origin?.sourceChannelId, parent.id);
      assert.equal(childView.messages[0]?.displayText, "Write the launch memo.");
      assert.notInclude(childView.messages[0]?.displayText ?? "", started.requestId);

      const replay = yield* service.startThread(input);
      assert.isFalse(replay.created);
      assert.equal(replay.channel.id, started.channel.id);
      assert.equal(
        (yield* orchestrator.getThreadProjection(started.channel.threadId)).messages.length,
        1,
        "a replay does not dispatch a second message",
      );
      const changed = yield* service
        .startThread({ ...input, task: "A different task." })
        .pipe(Effect.flip);
      assert.equal(changed.code, "peer_request_invalid");

      // The child reports back along the parent edge; anything else is refused.
      const reply = yield* service.sendToThread(started.channel.threadId, {
        channelId: parent.id,
        text: "Memo drafted.",
        clientRequestId: "memo-done",
      });
      assert.equal(reply.channelId, parent.id);
      const parentProjection = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.equal(parentProjection.messages[0]?.peerMessage?.type, "reply");
      assert.include(parentProjection.messages[0]?.text ?? "", "Memo drafted.");
      const parentView = yield* service.getView(parent.id);
      assert.equal(parentView.messages[0]?.origin?.kind, "peer_reply");
      assert.equal(parentView.messages[0]?.origin?.sourceName, "Draft the memo");
      assert.equal(parentView.messages[0]?.displayText, "Memo drafted.");

      const unrelated = yield* service.create({ name: "Elsewhere" });
      const refused = yield* service
        .sendToThread(started.channel.threadId, {
          channelId: unrelated.id,
          text: "hello",
          clientRequestId: "stray-1",
        })
        .pipe(Effect.flip);
      assert.equal(refused.code, "peer_request_invalid");
    }),
  );

  it.effect("routes peer requests across projects but never straight into a child chat", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const alpha = yield* service.createProject({
        name: "Alpha",
        commandId: CommandId.make("create-alpha"),
      });
      const beta = yield* service.createProject({
        name: "Beta",
        commandId: CommandId.make("create-beta"),
      });
      const alphaMain = (yield* service.getView(alpha.mainChannelId)).channel;
      const betaMain = (yield* service.getView(beta.mainChannelId)).channel;
      assert.notEqual(alphaMain.projectId, betaMain.projectId, "projects own separate workspaces");

      const request = yield* service.requestThread(alphaMain.threadId, {
        channelId: betaMain.id,
        text: "Check the invoice.",
        clientRequestId: "invoice-1",
      });
      const betaProjection = yield* orchestrator.getThreadProjection(betaMain.threadId);
      assert.equal(betaProjection.messages[0]?.peerMessage?.sourceThreadId, alphaMain.threadId);

      yield* service.replyToThread(betaMain.threadId, {
        requestId: request.requestId,
        text: "Already paid.",
      });
      const alphaProjection = yield* orchestrator.getThreadProjection(alphaMain.threadId);
      assert.equal(alphaProjection.messages[0]?.peerMessage?.type, "reply");
      assert.equal(alphaProjection.messages[0]?.peerMessage?.requestId, request.requestId);
      assert.include(alphaProjection.messages[0]?.text ?? "", "Already paid.");
      const alphaView = yield* service.getView(alphaMain.id);
      assert.equal(alphaView.messages[0]?.origin?.kind, "peer_reply");
      assert.equal(
        alphaView.messages[0]?.origin?.sourceName,
        `Beta · ${betaMain.name}`,
        "a chat in another project is qualified by that project",
      );
      assert.equal(alphaView.messages[0]?.displayText, "Already paid.");

      const child = yield* service.create({ name: "Beta child", parentChannelId: betaMain.id });
      const rejected = yield* service
        .requestThread(alphaMain.threadId, {
          channelId: child.id,
          text: "Do this instead.",
          clientRequestId: "direct-1",
        })
        .pipe(Effect.flip);
      assert.equal(rejected.code, "peer_request_invalid");
      assert.match(rejected.message, /main chat/);
    }),
  );

  it.effect("holds peer requests and replies until a snoozed chat wakes", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const until = "2099-07-25T09:00:00.000Z";
      const sender = yield* service.create({ name: "Sender" });
      const recipient = yield* service.createProject({
        name: "Recipient",
        commandId: CommandId.make("create-recipient"),
      });
      const recipientMain = (yield* service.getView(recipient.mainChannelId)).channel;

      yield* service.snooze({ channelId: recipientMain.id, until });
      const request = yield* service.requestThread(sender.threadId, {
        channelId: recipientMain.id,
        text: "Check the invoice.",
        clientRequestId: "snoozed-invoice-1",
      });

      const parked = yield* orchestrator.getThreadProjection(recipientMain.threadId);
      assert.equal(
        (yield* service.getView(recipientMain.id)).snoozedUntil,
        until,
        "a peer request never spends the user's snooze",
      );
      assert.equal(parked.messages.at(-1)?.peerMessage?.requestId, request.requestId);
      assert.deepEqual(
        parked.runs.map((run) => run.status),
        ["queued"],
      );

      yield* service.wake(recipientMain.id);
      yield* orchestrator.streamStoredEventsFrom({ threadId: recipientMain.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting",
        ),
        Stream.runHead,
      );
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(recipientMain.threadId)).runs.map(
          (run) => run.status,
        ),
        ["starting"],
      );

      // The answer respects the original sender's snooze the same way.
      yield* service.snooze({ channelId: sender.id, until });
      yield* service.replyToThread(recipientMain.threadId, {
        requestId: request.requestId,
        text: "Already paid.",
      });
      const parkedReply = yield* orchestrator.getThreadProjection(sender.threadId);
      assert.equal((yield* service.getView(sender.id)).snoozedUntil, until);
      assert.equal(parkedReply.messages.at(-1)?.peerMessage?.type, "reply");
      assert.deepEqual(
        parkedReply.runs.map((run) => run.status),
        ["queued"],
      );
    }),
  );

  it.effect("links knowledge to projects and guards every edit with a revision", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const one = yield* service.createProject({
        name: "One",
        commandId: CommandId.make("create-one"),
      });
      const two = yield* service.createProject({
        name: "Two",
        commandId: CommandId.make("create-two"),
      });
      const input = {
        title: "Ports",
        body: "The staging API listens on 3000.",
        ownerProjectId: one.id,
        projectIds: [two.id],
        commandId: CommandId.make("create-ports"),
      };
      const entry = yield* service.createKnowledge(input);
      assert.deepEqual(
        [...entry.projectIds].toSorted(),
        [one.id, two.id].toSorted(),
        "the owner is always linked",
      );
      assert.deepEqual(yield* service.createKnowledge(input), entry);
      assert.deepEqual(
        (yield* service.listKnowledge({ projectId: two.id })).entries.map((saved) => saved.id),
        [entry.id],
      );

      const unknown = yield* service
        .createKnowledge({
          title: "Stray",
          body: "",
          projectIds: [OpenbotProjectId.make("openbot-project:nope")],
          commandId: CommandId.make("create-stray"),
        })
        .pipe(Effect.flip);
      assert.equal(unknown.code, "project_not_found");

      const updated = yield* service.updateKnowledge({
        knowledgeId: entry.id,
        expectedRevision: entry.revision,
        body: "The staging API listens on 3001.",
        projectIds: [one.id],
      });
      assert.equal(updated.body, "The staging API listens on 3001.");
      assert.deepEqual([...updated.projectIds], [one.id], "projectIds replaces the link set");
      assert.deepEqual([...(yield* service.listKnowledge({ projectId: two.id })).entries], []);
      const stale = yield* service
        .updateKnowledge({ knowledgeId: entry.id, expectedRevision: entry.revision, body: "no" })
        .pipe(Effect.flip);
      assert.equal(stale.code, "knowledge_conflict");
      assert.equal((yield* service.getKnowledge(entry.id)).body, updated.body);

      yield* service.deleteKnowledge({
        knowledgeId: entry.id,
        expectedRevision: updated.revision,
      });
      assert.deepEqual([...(yield* service.listKnowledge({})).entries], []);
      const gone = yield* service.getKnowledge(entry.id).pipe(Effect.flip);
      assert.equal(gone.code, "knowledge_not_found");
    }),
  );

  it.effect(
    "carries project instructions, linked knowledge, and the child contract into a turn",
    () =>
      Effect.gen(function* () {
        const service = yield* OpenbotChannelService;
        const instructions = yield* ProviderTurnInstructionsV2;
        const project = yield* service.createProject({
          name: "Kitchen",
          instructions: "Always measure in grams.",
          commandId: CommandId.make("create-kitchen"),
        });
        yield* service.createKnowledge({
          title: "Oven quirks",
          body: "It runs twenty degrees hot.",
          ownerProjectId: project.id,
          commandId: CommandId.make("create-oven"),
        });
        const parent = (yield* service.getView(project.mainChannelId)).channel;
        const child = yield* service.create({ name: "Sourdough", parentChannelId: parent.id });

        const parentPrompt = yield* instructions.resolve({
          threadId: parent.threadId,
          runOrdinal: 1,
          messageCount: 1,
        });
        assert.include(parentPrompt ?? "", "Always measure in grams.");
        assert.include(parentPrompt ?? "", "Oven quirks");
        assert.include(parentPrompt ?? "", "It runs twenty degrees hot.");
        assert.notInclude(parentPrompt ?? "", "focused child chat");
        assert.include(parentPrompt ?? "", "Project coordination:");
        assert.include(parentPrompt ?? "", "openbot_start_thread");

        const childPrompt = yield* instructions.resolve({
          threadId: child.threadId,
          runOrdinal: 1,
          messageCount: 1,
        });
        assert.include(
          childPrompt ?? "",
          'This is the focused child chat "Sourdough" of "Kitchen"',
        );
        assert.include(childPrompt ?? "", "openbot_send_to_thread");
        assert.include(childPrompt ?? "", "Always measure in grams.");
        assert.notInclude(childPrompt ?? "", "Project coordination:");
        assert.include(childPrompt ?? "", "openbot_send_message");
      }),
  );

  it.effect("surfaces a pending question on the view and refuses an unknown request id", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const eventSink = yield* EventSinkV2;
      const chat = yield* service.create({ name: "Asks" });
      const sent = yield* service.send({ channelId: chat.id, text: "ship it" });
      const now = yield* DateTime.now;
      const requestId = RuntimeRequestId.make("request:openbot-test:1");
      yield* eventSink.write({
        events: [
          {
            id: "event:openbot-test:request" as never,
            type: "runtime-request.updated",
            threadId: chat.threadId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: NodeId.make("node:openbot-test"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
          {
            id: "event:openbot-test:item" as never,
            type: "turn-item.updated",
            threadId: chat.threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:openbot-test:1"),
              threadId: chat.threadId,
              runId: sent.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "pending",
              title: null,
              startedAt: null,
              completedAt: null,
              updatedAt: now,
              type: "user_input_request",
              requestId,
              questions: [
                {
                  id: "environment",
                  header: "Deploy",
                  question: "Which environment?",
                  options: [{ label: "prod", description: "Production" }],
                },
              ],
            },
          },
        ],
      });

      const view = yield* service.getView(chat.id);
      assert.equal(view.pendingRequests.length, 1);
      const pending = view.pendingRequests[0];
      assert.equal(pending?.type, "user_input");
      if (pending?.type !== "user_input") throw new Error("Expected a user_input request");
      assert.equal(pending.requestId, requestId);
      assert.equal(pending.responseCapability, "message");
      assert.deepEqual(
        pending.questions.map((question) => question.question),
        ["Which environment?"],
      );

      const missing = yield* service
        .respond({
          channelId: chat.id,
          requestId: RuntimeRequestId.make("request:openbot-test:missing"),
        })
        .pipe(Effect.flip);
      assert.equal(missing.code, "request_not_found");
      assert.match(missing.message, /expired or was already answered/);
    }),
  );
});
