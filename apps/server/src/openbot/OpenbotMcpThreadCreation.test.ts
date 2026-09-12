import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestratorMcpCreatedThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { mcpThreadCreationLayer, OpenbotChannelService } from "./OpenbotChannelService.ts";
import {
  makeOpenbotTestLayer,
  openbotModelSelection as modelSelection,
  openbotServerProvider,
} from "./OpenbotChannelService.testkit.ts";

const openbotLayer = makeOpenbotTestLayer("t3-openbot-mcp-create-threads-");

// The orchestrator MCP service over the same orchestrator the OpenBot service
// uses. The router arrives through the surrounding context, as it does in
// production: the runtime layer exposes it and `server.ts` provides that
// context to the layer that builds this service.
const runtimeLayer = Layer.mergeAll(
  openbotLayer,
  mcpThreadCreationLayer.pipe(Layer.provide(openbotLayer)),
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([openbotServerProvider]) }),
  Layer.mock(ScheduledTaskService)({}),
);

const TestLayer = OrchestratorMcpService.layer.pipe(Layer.provideMerge(runtimeLayer));

const scopeFor = (threadId: ThreadId, providerSessionId: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:openbot-mcp-create-threads"),
  threadId,
  providerSessionId,
  providerInstanceId: modelSelection.instanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const onlyThread = (
  threads: ReadonlyArray<OrchestratorMcpCreatedThread>,
): OrchestratorMcpCreatedThread => {
  assert.equal(threads.length, 1);
  const thread = threads[0];
  if (thread === undefined) throw new Error("Expected one created thread");
  return thread;
};

/** The agent can only create threads while its own turn is running. */
const activeProjectThreadCount = (projectId: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const listed = yield* threads.listProjectThreads({
      projectId: projectId as never,
      includeSubagents: true,
    });
    return listed.length;
  });

it.layer(TestLayer)("create_threads from an OpenBot chat", (it) => {
  it.effect("gives a project main chat a visible child chat carrying the task", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      const project = yield* service.createProject({
        name: "Garden",
        commandId: CommandId.make("create-garden"),
      });
      const main = (yield* service.getView(project.mainChannelId)).channel;
      yield* service.send({ channelId: main.id, text: "can you make a thread please" });

      const scope = scopeFor(main.threadId, "provider-session:with-prompt");
      const input = {
        threads: [{ prompt: "Research mulch options.", title: "Mulch research" }],
        clientRequestId: "make-a-thread",
      };
      const created = onlyThread((yield* mcp.createThreads(scope, input)).threads);

      const child = (yield* service.list).channels.find(
        (candidate) => candidate.threadId === created.threadId,
      );
      assert.equal(child?.parentChannelId, main.id, "the child hangs off the main chat");
      assert.equal(child?.openbotProjectId, project.id);
      assert.equal(child?.name, "Mulch research");
      assert.equal(created.title, "Mulch research");

      // The child holds a peer request from the parent, not a bare user message.
      const childProjection = yield* orchestrator.getThreadProjection(created.threadId);
      assert.equal(childProjection.messages.length, 1);
      assert.include(childProjection.messages[0]?.text ?? "", "Research mulch options.");
      assert.equal(childProjection.messages[0]?.peerMessage?.type, "request");
      assert.equal(childProjection.messages[0]?.peerMessage?.sourceThreadId, main.threadId);
      assert.equal(created.runId, childProjection.runs[0]?.id);

      // The parent's T3 timeline still records the thread it created.
      const parentProjection = yield* orchestrator.getThreadProjection(main.threadId);
      assert.isTrue(
        parentProjection.turnItems.some(
          (item) => item.type === "thread_created" && item.targetThreadId === created.threadId,
        ),
        "the parent timeline records the created thread",
      );

      // A retry of the same request returns the same child.
      const retried = onlyThread((yield* mcp.createThreads(scope, input)).threads);
      assert.equal(retried.threadId, created.threadId);
      assert.equal(
        (yield* service.list).channels.filter((candidate) => candidate.parentChannelId === main.id)
          .length,
        1,
        "a retry does not create a second child",
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(created.threadId)).messages.length,
        1,
        "a retry does not dispatch the task twice",
      );
    }),
  );

  it.effect("creates an empty child chat when no prompt was given", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      const project = yield* service.createProject({
        name: "Kitchen",
        commandId: CommandId.make("create-kitchen"),
      });
      const main = (yield* service.getView(project.mainChannelId)).channel;
      yield* service.send({ channelId: main.id, text: "make an empty thread" });

      const created = onlyThread(
        (yield* mcp.createThreads(scopeFor(main.threadId, "provider-session:no-prompt"), {
          threads: [{ title: "Scratch pad" }],
          clientRequestId: "empty-thread",
        })).threads,
      );

      const child = (yield* service.list).channels.find(
        (candidate) => candidate.threadId === created.threadId,
      );
      assert.equal(child?.parentChannelId, main.id);
      assert.equal(child?.name, "Scratch pad");
      assert.equal(created.runId, null);
      assert.equal(created.status, "idle");
      const projection = yield* orchestrator.getThreadProjection(created.threadId);
      assert.equal(projection.messages.length, 0);
      assert.equal(projection.runs.length, 0);
    }),
  );

  it.effect("carries the caller's mode overrides into the child chats it makes", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      const project = yield* service.createProject({
        name: "Studio",
        commandId: CommandId.make("create-studio"),
      });
      const main = (yield* service.getView(project.mainChannelId)).channel;
      yield* service.send({ channelId: main.id, text: "make two careful threads" });

      // Both creation shapes, so the prompted and the empty child both carry
      // the modes rather than the OpenBot defaults.
      const created = (yield* mcp.createThreads(scopeFor(main.threadId, "provider-session:modes"), {
        threads: [
          {
            prompt: "Plan the rebuild.",
            title: "Planned work",
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
          { title: "Planned scratch", runtimeMode: "auto", interactionMode: "plan" },
        ],
        clientRequestId: "modes-1",
      })).threads;
      assert.equal(created.length, 2);

      const prompted = yield* orchestrator.getThreadProjection(created[0]!.threadId);
      assert.equal(prompted.thread.runtimeMode, "approval-required");
      assert.equal(prompted.thread.interactionMode, "plan");
      const empty = yield* orchestrator.getThreadProjection(created[1]!.threadId);
      assert.equal(empty.thread.runtimeMode, "auto");
      assert.equal(empty.thread.interactionMode, "plan");
    }),
  );

  it.effect("refuses a runtime mode broader than the caller's before creating anything", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      const project = yield* service.createProject({
        name: "Vault",
        commandId: CommandId.make("create-vault"),
      });
      const main = (yield* service.getView(project.mainChannelId)).channel;
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("command:vault-main:narrow"),
        threadId: main.threadId,
        runtimeMode: "approval-required",
      });
      yield* service.send({ channelId: main.id, text: "make a wide open thread" });
      const channelsBefore = (yield* service.list).channels.length;

      const refusal = yield* mcp
        .createThreads(scopeFor(main.threadId, "provider-session:escalation"), {
          threads: [{ prompt: "Do it wide open.", runtimeMode: "full-access" }],
          clientRequestId: "escalation-1",
        })
        .pipe(Effect.flip);
      assert.equal(refusal.code, "runtime_mode_escalation_denied");
      assert.equal((yield* service.list).channels.length, channelsBefore, "no chat was created");
    }),
  );

  it.effect("turns an empty child then the same key with a prompt into one started child", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      const project = yield* service.createProject({
        name: "Attic",
        commandId: CommandId.make("create-attic"),
      });
      const main = (yield* service.getView(project.mainChannelId)).channel;
      yield* service.send({ channelId: main.id, text: "make a thread, then fill it" });

      const scope = scopeFor(main.threadId, "provider-session:empty-then-prompt");
      const first = onlyThread(
        (yield* mcp.createThreads(scope, {
          threads: [{ title: "Boxed up" }],
          clientRequestId: "fill-later",
        })).threads,
      );
      assert.equal(first.runId, null);

      const second = onlyThread(
        (yield* mcp.createThreads(scope, {
          threads: [{ title: "Boxed up", prompt: "Sort the boxes." }],
          clientRequestId: "fill-later",
        })).threads,
      );
      assert.equal(second.threadId, first.threadId, "the prompt lands in the child already made");
      assert.equal(
        (yield* service.list).channels.filter((candidate) => candidate.parentChannelId === main.id)
          .length,
        1,
        "the prompted retry does not make a second child",
      );
      const projection = yield* orchestrator.getThreadProjection(first.threadId);
      assert.equal(projection.messages.length, 1);
      assert.include(projection.messages[0]?.text ?? "", "Sort the boxes.");
      assert.equal(second.runId, projection.runs.at(-1)?.id);
    }),
  );

  it.effect("returns the same child when the same key comes back without its prompt", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      const project = yield* service.createProject({
        name: "Cellar",
        commandId: CommandId.make("create-cellar"),
      });
      const main = (yield* service.getView(project.mainChannelId)).channel;
      yield* service.send({ channelId: main.id, text: "make a thread and start it" });

      const scope = scopeFor(main.threadId, "provider-session:prompt-then-empty");
      const first = onlyThread(
        (yield* mcp.createThreads(scope, {
          threads: [{ title: "Racked", prompt: "Rack the bottles." }],
          clientRequestId: "start-then-empty",
        })).threads,
      );
      const second = onlyThread(
        (yield* mcp.createThreads(scope, {
          threads: [{ title: "Racked" }],
          clientRequestId: "start-then-empty",
        })).threads,
      );

      assert.equal(second.threadId, first.threadId);
      assert.equal(
        (yield* service.list).channels.filter((candidate) => candidate.parentChannelId === main.id)
          .length,
        1,
        "the empty retry does not make a second child",
      );
      const projection = yield* orchestrator.getThreadProjection(first.threadId);
      assert.equal(projection.messages.length, 1, "the empty retry does not dispatch again");
    }),
  );

  it.effect("refuses a child chat that asks for children of its own", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const project = yield* service.createProject({
        name: "Workshop",
        commandId: CommandId.make("create-workshop"),
      });
      const main = (yield* service.getView(project.mainChannelId)).channel;
      const started = yield* service.startThread({
        parentChannelId: main.id,
        title: "Sand the shelf",
        task: "Sand the shelf.",
        clientRequestId: "shelf-1",
      });
      const channelsBefore = (yield* service.list).channels.length;
      const threadsBefore = yield* activeProjectThreadCount(main.projectId);

      const refusal = yield* mcp
        .createThreads(scopeFor(started.channel.threadId, "provider-session:child"), {
          threads: [{ prompt: "Delegate further." }],
          clientRequestId: "nested-1",
        })
        .pipe(Effect.flip);
      assert.equal(refusal.code, "invalid_request");
      assert.include(refusal.message, "child chat cannot own child chats");
      assert.equal((yield* service.list).channels.length, channelsBefore, "no chat was created");
      assert.equal(
        yield* activeProjectThreadCount(main.projectId),
        threadsBefore,
        "no thread was created either",
      );
    }),
  );

  it.effect("leaves a standalone OpenBot chat on the generic thread path", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      const chat = yield* service.create({ name: "Standalone" });
      assert.equal(chat.openbotProjectId, null);
      yield* service.send({ channelId: chat.id, text: "make a thread" });

      const created = onlyThread(
        (yield* mcp.createThreads(scopeFor(chat.threadId, "provider-session:standalone"), {
          threads: [{ prompt: "Generic work." }],
          clientRequestId: "standalone-1",
        })).threads,
      );

      const projection = yield* orchestrator.getThreadProjection(created.threadId);
      assert.equal(projection.thread.creationSource, "mcp");
      assert.isUndefined(
        (yield* service.list).channels.find((candidate) => candidate.threadId === created.threadId),
        "a standalone chat's generic thread stays a plain T3 thread",
      );
    }),
  );

  it.effect("leaves a plain T3 thread on the generic thread path", () =>
    Effect.gen(function* () {
      const service = yield* OpenbotChannelService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* OrchestratorV2;
      // The chat only supplies a real project; the caller below is an ordinary
      // T3 thread in it with no OpenBot channel of its own.
      const chat = yield* service.create({ name: "Project owner" });
      const callerThreadId = ThreadId.make("thread:plain-t3-caller");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:plain-t3-caller:create"),
        threadId: callerThreadId,
        projectId: chat.projectId,
        title: "Plain T3 thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:plain-t3-caller:start"),
        threadId: callerThreadId,
        messageId: MessageId.make("message:plain-t3-caller:start"),
        text: "make a thread",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const created = onlyThread(
        (yield* mcp.createThreads(scopeFor(callerThreadId, "provider-session:plain"), {
          threads: [{ prompt: "Generic work." }],
          clientRequestId: "plain-1",
        })).threads,
      );

      const projection = yield* orchestrator.getThreadProjection(created.threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.text, "Generic work.");
      assert.isUndefined(
        (yield* service.list).channels.find((candidate) => candidate.threadId === created.threadId),
        "a plain T3 thread gains no OpenBot channel",
      );
    }),
  );
});
