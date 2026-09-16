import { assert, it } from "@effect/vitest";
import { CommandId, OpenbotChannelId, OpenbotProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { OpenbotChannelService } from "./OpenbotChannelService.ts";
import { makeOpenbotTestLayer } from "./OpenbotChannelService.testkit.ts";

const TestLayer = makeOpenbotTestLayer("t3-openbot-deletion-");

const commandId = (name: string) => CommandId.make(`command:openbot-deletion:${name}`);

/**
 * Deleting an OpenBot chat means deleting its T3 thread; deleting a project
 * means deleting its chats and tombstoning the project row. These tests drive
 * the same service methods the RPC layer and the MCP toolkit call, and assert
 * what a caller can see afterwards rather than which rows moved.
 */
it.layer(TestLayer)("OpenBot deletion", (it) => {
  it.effect("hides a deleted child chat and unlinks it from the parent's timeline", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const project = yield* service.createProject({
        name: "Ops",
        commandId: commandId("child-project"),
      });
      const parent = (yield* service.getView(project.mainChannelId)).channel;
      const bystander = yield* service.create({
        name: "Bystander",
        commandId: commandId("child-bystander"),
      });
      const started = yield* service.startThread({
        parentChannelId: parent.id,
        title: "Draft the memo",
        task: "Write the launch memo.",
        clientRequestId: "memo-1",
      });
      const before = yield* service.getView(parent.id);
      assert.deepEqual(
        before.events.map((event) => event.targetChannelId),
        [started.channel.id],
        "the parent's timeline links to the live child",
      );

      yield* service.deleteChannel({
        channelId: started.channel.id,
        commandId: commandId("child-delete"),
      });

      const channelIds = (yield* service.list).channels.map((channel) => channel.id);
      assert.notInclude(channelIds, started.channel.id);
      assert.includeMembers(channelIds, [parent.id, bystander.id], "nothing else was touched");
      const missing = yield* service.getView(started.channel.id).pipe(Effect.flip);
      assert.equal(missing.code, "channel_not_found");

      const after = yield* service.getView(parent.id);
      assert.deepEqual(
        after.events.map((event) => [event.targetThreadId, event.targetChannelId]),
        [[started.channel.threadId, null]],
        "the record of the thread stays; the link to the chat resolves to nothing",
      );

      // A peer message can no longer be routed into the deleted chat.
      const refused = yield* service
        .sendToThread(parent.threadId, {
          channelId: started.channel.id,
          text: "still there?",
          clientRequestId: "memo-followup",
        })
        .pipe(Effect.flip);
      assert.equal(refused.code, "channel_not_found");
    }),
  );

  it.effect("deleting a parent chat takes its children with it", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const parent = yield* service.create({
        name: "Planner",
        commandId: commandId("cascade-parent"),
      });
      const childA = yield* service.create({
        name: "Child A",
        parentChannelId: parent.id,
        commandId: commandId("cascade-a"),
      });
      const childB = yield* service.create({
        name: "Child B",
        parentChannelId: parent.id,
        commandId: commandId("cascade-b"),
      });
      const other = yield* service.create({
        name: "Other",
        commandId: commandId("cascade-other"),
      });

      yield* service.deleteChannel({
        channelId: parent.id,
        commandId: commandId("cascade-delete"),
      });

      const channelIds = (yield* service.list).channels.map((channel) => channel.id);
      for (const gone of [parent.id, childA.id, childB.id]) assert.notInclude(channelIds, gone);
      assert.include(channelIds, other.id);
    }),
  );

  it.effect("refuses to delete a project's main chat on its own", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const project = yield* service.createProject({
        name: "Recipes",
        commandId: commandId("main-project"),
      });
      const refused = yield* service
        .deleteChannel({ channelId: project.mainChannelId, commandId: commandId("main-delete") })
        .pipe(Effect.flip);
      assert.equal(refused.code, "delete_project_instead");
      assert.equal(refused.channelId, project.mainChannelId);

      assert.include(
        (yield* service.listProjects).projects.map((entry) => entry.id),
        project.id,
        "the project is untouched",
      );
      assert.include(
        (yield* service.list).channels.map((channel) => channel.id),
        project.mainChannelId,
      );
    }),
  );

  it.effect("deletes a project with its chats and its own knowledge, keeping the workspace", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const fs = yield* FileSystem.FileSystem;
      const project = yield* service.createProject({
        name: "Garden",
        commandId: commandId("project-garden"),
      });
      const unrelated = yield* service.createProject({
        name: "Kitchen",
        commandId: commandId("project-kitchen"),
      });
      const child = yield* service.create({
        name: "Weeding",
        parentChannelId: project.mainChannelId,
        commandId: commandId("project-child"),
      });
      const owned = yield* service.createKnowledge({
        title: "Bed layout",
        body: "Three raised beds.",
        ownerProjectId: project.id,
        commandId: commandId("knowledge-owned"),
      });
      const shared = yield* service.createKnowledge({
        title: "Frost dates",
        body: "Last frost in April.",
        projectIds: [project.id, unrelated.id],
        commandId: commandId("knowledge-shared"),
      });
      assert.equal(shared.ownerProjectId, null);
      const sharedOwned = yield* service.createKnowledge({
        title: "Planting calendar",
        body: "Plant after the last frost.",
        ownerProjectId: project.id,
        projectIds: [project.id, unrelated.id],
        commandId: commandId("knowledge-shared-owned"),
      });

      yield* service.deleteProject({
        projectId: project.id,
        commandId: commandId("project-delete"),
      });

      const projectIds = (yield* service.listProjects).projects.map((entry) => entry.id);
      assert.notInclude(projectIds, project.id);
      assert.include(projectIds, unrelated.id);
      const gone = yield* service.getProject(project.id).pipe(Effect.flip);
      assert.equal(gone.code, "project_not_found");

      const channelIds = (yield* service.list).channels.map((entry) => entry.id);
      assert.notInclude(channelIds, project.mainChannelId);
      assert.notInclude(channelIds, child.id);
      assert.include(channelIds, unrelated.mainChannelId, "another project keeps its chats");

      const knowledgeIds = (yield* service.listKnowledge({})).entries.map((entry) => entry.id);
      assert.notInclude(knowledgeIds, owned.id, "knowledge the project maintained goes with it");
      assert.include(knowledgeIds, shared.id, "knowledge shared from elsewhere is kept");
      const retained = (yield* service.listKnowledge({})).entries.find(
        (entry) => entry.id === sharedOwned.id,
      );
      assert.isDefined(retained);
      assert.equal(retained?.ownerProjectId, null);
      assert.deepEqual(retained?.projectIds, [unrelated.id]);

      assert.isTrue(
        yield* fs.exists(project.workspace.path),
        "deletion never removes files from disk",
      );
    }),
  );

  it.effect("reuses a deleted bot folder with a fresh identity", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const original = yield* service.createProject({
        name: "Original",
        commandId: commandId("reuse-original"),
      });
      yield* service.deleteProject({
        projectId: original.id,
        commandId: commandId("reuse-delete"),
      });
      const replacement = yield* service.createProject({
        name: "Replacement",
        attachedPath: original.workspace.path,
        commandId: commandId("reuse-replacement"),
      });
      assert.notEqual(replacement.t3ProjectId, original.t3ProjectId);
      assert.equal(
        (yield* service.getView(replacement.mainChannelId)).channel.openbotProjectId,
        replacement.id,
      );
    }),
  );

  it.effect("is idempotent for chats and for projects, whatever command id retries it", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const chat = yield* service.create({ name: "Twice", commandId: commandId("twice-chat") });
      yield* service.deleteChannel({ channelId: chat.id, commandId: commandId("twice-a") });
      yield* service.deleteChannel({ channelId: chat.id, commandId: commandId("twice-a") });
      yield* service.deleteChannel({ channelId: chat.id, commandId: commandId("twice-b") });
      yield* service.deleteChannel({
        channelId: OpenbotChannelId.make("openbot-channel:never-existed"),
        commandId: commandId("twice-missing"),
      });

      const project = yield* service.createProject({
        name: "Twice project",
        commandId: commandId("twice-project"),
      });
      yield* service.deleteProject({ projectId: project.id, commandId: commandId("twice-p-a") });
      yield* service.deleteProject({ projectId: project.id, commandId: commandId("twice-p-a") });
      yield* service.deleteProject({ projectId: project.id, commandId: commandId("twice-p-b") });
      yield* service.deleteProject({
        projectId: OpenbotProjectId.make("openbot-project:never-existed"),
        commandId: commandId("twice-p-missing"),
      });
    }),
  );

  it.effect("refuses to rebuild a deleted chat or project from a replayed create", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const create = { name: "Revenant", commandId: commandId("revenant-chat") };
      const chat = yield* service.create(create);
      yield* service.deleteChannel({ channelId: chat.id, commandId: commandId("revenant-delete") });
      const replayed = yield* service.create(create).pipe(Effect.flip);
      assert.equal(replayed.code, "channel_deleted");
      assert.notInclude(
        (yield* service.list).channels.map((entry) => entry.id),
        chat.id,
      );

      const parent = yield* service.create({
        name: "Owner",
        commandId: commandId("revenant-parent"),
      });
      const start = {
        parentChannelId: parent.id,
        title: "Focused",
        task: "Do the thing.",
        clientRequestId: "revenant-1",
      };
      const started = yield* service.startThread(start);
      yield* service.deleteChannel({
        channelId: started.channel.id,
        commandId: commandId("revenant-child-delete"),
      });
      const replayedChild = yield* service.startThread(start).pipe(Effect.flip);
      assert.equal(replayedChild.code, "channel_deleted");

      const projectInput = { name: "Revenant project", commandId: commandId("revenant-project") };
      const project = yield* service.createProject(projectInput);
      yield* service.deleteProject({
        projectId: project.id,
        commandId: commandId("revenant-project-delete"),
      });
      const replayedProject = yield* service.createProject(projectInput).pipe(Effect.flip);
      assert.equal(replayedProject.code, "project_deleted");
      assert.notInclude(
        (yield* service.listProjects).projects.map((entry) => entry.id),
        project.id,
      );
    }),
  );

  it.effect("cancels the active run and the runs queued behind it", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const chat = yield* service.create({ name: "Busy", commandId: commandId("busy") });
      yield* service.send({ channelId: chat.id, text: "first" });
      yield* service.send({ channelId: chat.id, text: "second" });
      const before = yield* orchestrator.getThreadProjection(chat.threadId);
      assert.deepEqual(before.runs.map((run) => run.status).toSorted(), ["queued", "starting"]);

      yield* service.deleteChannel({ channelId: chat.id, commandId: commandId("busy-delete") });

      const after = yield* orchestrator.getThreadProjection(chat.threadId);
      assert.isNotNull(after.thread.deletedAt);
      assert.deepEqual(
        [...new Set(after.runs.map((run) => run.status))],
        ["cancelled"],
        "no run survives the deletion of its thread",
      );
    }),
  );

  it.effect("never launches a run parked behind a snooze on a deleted chat", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const orchestrator = yield* OrchestratorV2;
      const chat = yield* service.create({ name: "Snoozed", commandId: commandId("snoozed") });
      const sender = yield* service.create({
        name: "Sender",
        commandId: commandId("snooze-sender"),
      });
      const until = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 5 }));
      yield* service.snooze({ channelId: chat.id, until });
      yield* service.requestThread(sender.threadId, {
        channelId: chat.id,
        text: "Check this after the snooze.",
        clientRequestId: "snoozed-request",
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(chat.threadId)).runs.map((run) => run.status),
        ["queued"],
      );

      yield* service.deleteChannel({ channelId: chat.id, commandId: commandId("snoozed-delete") });
      yield* TestClock.adjust("6 minutes");
      yield* orchestrator.promoteExpiredSnoozes;

      const after = yield* orchestrator.getThreadProjection(chat.threadId);
      assert.deepEqual(
        after.runs.map((run) => run.status),
        ["cancelled"],
        "the parked run is cancelled and the snooze sweep cannot revive it",
      );
    }),
  );
  it.effect("removes only routines bound to deleted chats and stops before a failed child", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const routines = yield* ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const parent = yield* service.create({
        name: "Routine owner",
        commandId: commandId("routine-parent"),
      });
      const child = yield* service.startThread({
        parentChannelId: parent.id,
        title: "Routine child",
        task: "Wait",
        clientRequestId: "routine-child",
      });
      const bystander = yield* service.create({
        name: "Other routines",
        commandId: commandId("routine-other"),
      });
      const base = {
        title: "Disabled routine",
        prompt: "Wait",
        enabled: false,
        schedule: { type: "cron", expression: "0 9 * * *", timeZone: "UTC" },
        workspaceStrategy: { type: "root" },
        modelSelection: parent.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      const bound = yield* routines.upsert({
        ...base,
        projectId: parent.projectId,
        threadId: child.channel.threadId,
      });
      const unrelated = yield* routines.upsert({
        ...base,
        projectId: bystander.projectId,
        threadId: bystander.threadId,
      });
      const unbound = yield* routines.upsert({ ...base, projectId: parent.projectId });
      // Exercise a real persistence failure, then remove it and retry the same tree.
      yield* sql`CREATE TEMP TRIGGER reject_routine_delete BEFORE DELETE ON scheduled_tasks BEGIN SELECT RAISE(ABORT, 'test delete failure'); END`;
      const failed = yield* service
        .deleteChannel({ channelId: parent.id, commandId: commandId("routine-fail") })
        .pipe(Effect.flip);
      assert.equal(failed.code, "orchestration_error");
      assert.includeMembers(
        (yield* service.list).channels.map((channel) => channel.id),
        [parent.id, child.channel.id],
      );
      yield* sql`DROP TRIGGER reject_routine_delete`;
      yield* service.deleteChannel({ channelId: parent.id, commandId: commandId("routine-retry") });
      const remaining = (yield* routines.list()).tasks.map((task) => task.id);
      assert.notInclude(remaining, bound.task.id);
      assert.includeMembers(remaining, [unrelated.task.id, unbound.task.id]);
      assert.notInclude(
        (yield* service.list).channels.map((channel) => channel.id),
        parent.id,
      );
      assert.notInclude(
        (yield* service.list).channels.map((channel) => channel.id),
        child.channel.id,
      );
    }),
  );
});
