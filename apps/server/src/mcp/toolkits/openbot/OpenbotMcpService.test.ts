import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OpenbotChannelId,
  OpenbotError,
  OpenbotKnowledgeId,
  OpenbotProjectId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OpenbotChannel,
  type OpenbotChannelCreateInput,
  type OpenbotChannelUpdateInput,
  type OpenbotChannelView,
  type OpenbotContextUpdateInput,
  type OpenbotKnowledge,
  type OpenbotKnowledgeUpdateInput,
  type OpenbotKnowledgeCreateInput,
  type OpenbotProject,
  type OpenbotProjectCreateInput,
  type OpenbotThreadStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenbotChannelService } from "../../../openbot/OpenbotChannelService.ts";
import { OpenbotQuestionService } from "../../../openbot/OpenbotQuestionService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import * as OpenbotMcp from "./OpenbotMcpService.ts";

const callerThreadId = ThreadId.make("thread:openbot-caller");
const callerChannelId = OpenbotChannelId.make("openbot:caller");
const otherChannelId = OpenbotChannelId.make("openbot:child");
const projectId = OpenbotProjectId.make("openbot-project:garden");
const knowledgeId = OpenbotKnowledgeId.make("openbot-knowledge:beds");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:openbot-test"),
  threadId: callerThreadId,
  providerSessionId: "provider-session:openbot-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

const callerChannel: OpenbotChannel = {
  id: callerChannelId,
  name: "Garden planner",
  avatar: "",
  description: "",
  revision: 0,
  projectId: ProjectId.make("project:openbot"),
  threadId: callerThreadId,
  modelSelection,
  parentChannelId: null,
  openbotProjectId: projectId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const viewFor = (channel: OpenbotChannel): OpenbotChannelView => ({
  channel,
  status: "idle",
  messages: [],
  deliveries: [],
  pendingRequests: [],
  events: [],
  snoozedUntil: "2026-01-02T00:00:00.000Z",
});

const project: OpenbotProject = {
  id: projectId,
  name: "Garden planner",
  icon: { name: "Plant", color: "green" },
  instructions: "",
  revision: 3,
  t3ProjectId: ProjectId.make("project:openbot"),
  mainChannelId: callerChannelId,
  workspace: { kind: "managed", path: "/tmp/openbot/projects/garden" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const knowledge: OpenbotKnowledge = {
  id: knowledgeId,
  title: "Garden bed layout",
  body: "Four raised beds.",
  ownerProjectId: projectId,
  projectIds: [projectId],
  revision: 7,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

type ChannelServiceShape = OpenbotChannelService["Service"];

function serviceLayer(overrides: Partial<ChannelServiceShape>) {
  return OpenbotMcp.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OpenbotChannelService)({
          channelForThread: () => Effect.succeed(callerChannel),
          getView: (channelId) =>
            Effect.succeed(viewFor({ ...callerChannel, id: channelId, threadId: callerThreadId })),
          ...overrides,
        }),
        Layer.mock(OpenbotQuestionService)({}),
        NodeCrypto.layer,
      ),
    ),
  );
}

const useService = <A, E>(
  overrides: Partial<ChannelServiceShape>,
  run: (service: OpenbotMcp.OpenbotMcpService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(OpenbotMcp.OpenbotMcpService, run).pipe(Effect.provide(serviceLayer(overrides)));

it.effect("starts a child chat under the calling chat and routes its result home", () =>
  Effect.gen(function* () {
    let started: (OpenbotThreadStartInput & { readonly originThreadId?: ThreadId }) | undefined;

    const result = yield* useService(
      {
        startThread: (input) => {
          started = input;
          return Effect.succeed({
            channel: { ...callerChannel, id: otherChannelId, parentChannelId: callerChannelId },
            requestId: "message:request" as never,
            messageId: "message:dispatched" as never,
            created: true,
          });
        },
      },
      (service) =>
        service.startThread(scope, {
          title: "Soil test",
          task: "Check the pH of bed three.",
          clientRequestId: "onboard:soil-test",
        }),
    );

    assert.strictEqual(started?.parentChannelId, callerChannelId);
    assert.strictEqual(started?.originThreadId, callerThreadId);
    assert.strictEqual(started?.task, "Check the pH of bed three.");
    assert.strictEqual(result.channelId, otherChannelId);
    assert.isTrue(result.created);
  }),
);

it.effect("surfaces a child chat's nesting refusal as nesting_not_allowed", () =>
  Effect.gen(function* () {
    const error = yield* useService(
      {
        startThread: () =>
          Effect.fail(
            new OpenbotError({
              code: "nesting_not_allowed",
              message: "A child chat cannot start another child chat.",
            }),
          ),
      },
      (service) =>
        service.startThread(scope, {
          title: "Deeper",
          task: "Nest once more.",
          clientRequestId: "nested",
        }),
    ).pipe(Effect.flip);

    assert.strictEqual(error.code, "nesting_not_allowed");
  }),
);

it.effect("scopes the visible chat list to the calling thread", () =>
  Effect.gen(function* () {
    let caller: ThreadId | undefined;

    yield* useService(
      {
        listThreads: (input) => {
          caller = input.callerThreadId;
          return Effect.succeed({ threads: [] });
        },
      },
      (service) => service.listThreads(scope, {}),
    );

    assert.strictEqual(caller, callerThreadId);
  }),
);

it.effect("snoozes the calling chat when no channel is named", () =>
  Effect.gen(function* () {
    let snoozed: { readonly channelId: OpenbotChannelId; readonly until: string } | undefined;

    const result = yield* useService(
      {
        snooze: (input) => {
          snoozed = input;
          return Effect.succeed(callerChannel);
        },
      },
      (service) => service.snoozeThread(scope, { until: "2026-01-02T00:00:00.000Z" }),
    );

    assert.strictEqual(snoozed?.channelId, callerChannelId);
    assert.strictEqual(result.channelId, callerChannelId);
    // The control result reports live status and snooze, which the stored
    // channel does not carry; both come from the post-write view.
    assert.strictEqual(result.status, "idle");
    assert.strictEqual(result.snoozedUntil, "2026-01-02T00:00:00.000Z");
  }),
);

it.effect("controls a named chat without resolving the calling chat", () =>
  Effect.gen(function* () {
    let cancelled: OpenbotChannelId | undefined;

    const result = yield* useService(
      {
        channelForThread: () => Effect.die("must not resolve the calling chat"),
        cancel: (channelId) => {
          cancelled = channelId;
          return Effect.succeed({ ...callerChannel, id: channelId });
        },
      },
      (service) => service.cancelThread(scope, { channelId: otherChannelId }),
    );

    assert.strictEqual(cancelled, otherChannelId);
    assert.strictEqual(result.channelId, otherChannelId);
  }),
);

it.effect("rejects a chat control call from a thread that is not an OpenBot chat", () =>
  Effect.gen(function* () {
    const error = yield* useService(
      { channelForThread: () => Effect.succeed(undefined as OpenbotChannel | undefined) },
      (service) => service.wakeThread(scope, {}),
    ).pipe(Effect.flip);

    assert.strictEqual(error.code, "not_a_channel");
  }),
);

it.effect("creates a project with a command id derived from the client request id", () =>
  Effect.gen(function* () {
    let created: OpenbotProjectCreateInput | undefined;

    yield* useService(
      {
        createProject: (input) => {
          created = input;
          return Effect.succeed(project);
        },
      },
      (service) =>
        service.createProject(scope, {
          name: "Garden planner",
          clientRequestId: "onboard:garden planner",
        }),
    );

    assert.strictEqual(created?.commandId, "command:openbot:project:onboard%3Agarden%20planner");
    assert.isUndefined(created?.attachedPath);
  }),
);

it.effect("creates a knowledge entry when no id is supplied", () =>
  Effect.gen(function* () {
    let created: OpenbotKnowledgeCreateInput | undefined;

    yield* useService(
      {
        createKnowledge: (input) => {
          created = input;
          return Effect.succeed(knowledge);
        },
        updateKnowledge: () => Effect.die("must not update when creating"),
      },
      (service) =>
        service.knowledgeWrite(scope, {
          title: "Garden bed layout",
          body: "Four raised beds.",
          projectIds: [projectId],
          clientRequestId: "onboard:beds",
        }),
    );

    assert.strictEqual(created?.commandId, "command:openbot:knowledge:onboard%3Abeds");
    assert.deepStrictEqual(created?.projectIds, [projectId]);
  }),
);

it.effect("updates a knowledge entry with compare-and-swap when an id is supplied", () =>
  Effect.gen(function* () {
    let updated: OpenbotKnowledgeUpdateInput | undefined;

    yield* useService(
      {
        createKnowledge: () => Effect.die("must not create when updating"),
        updateKnowledge: (input) => {
          updated = input;
          return Effect.succeed(knowledge);
        },
      },
      (service) =>
        service.knowledgeWrite(scope, {
          knowledgeId,
          expectedRevision: 7,
          title: "Garden bed layout",
          body: "Four raised beds, clay soil.",
        }),
    );

    assert.strictEqual(updated?.knowledgeId, knowledgeId);
    assert.strictEqual(updated?.expectedRevision, 7);
    assert.strictEqual(updated?.body, "Four raised beds, clay soil.");
  }),
);

it.effect("refuses a knowledge update that skipped reading the current revision", () =>
  Effect.gen(function* () {
    const error = yield* useService(
      {
        createKnowledge: () => Effect.die("must not create for an existing id"),
        updateKnowledge: () => Effect.die("must not write without a revision"),
      },
      (service) =>
        service.knowledgeWrite(scope, {
          knowledgeId,
          title: "Garden bed layout",
          body: "Overwrites whatever is there.",
        }),
    ).pipe(Effect.flip);

    assert.strictEqual(error.code, "request_conflict");
    assert.include(error.message, "openbot_knowledge_read");
  }),
);

it.effect("creates a standalone chat with no parent and an idempotent command id", () =>
  Effect.gen(function* () {
    let created: OpenbotChannelCreateInput | undefined;

    yield* useService(
      {
        create: (input) => {
          created = input;
          return Effect.succeed(callerChannel);
        },
      },
      (service) =>
        service.createChat(scope, {
          name: "Weekly review",
          clientRequestId: "onboard:weekly review",
        }),
    );

    assert.strictEqual(created?.commandId, "command:openbot:chat:onboard%3Aweekly%20review");
    assert.isUndefined(created?.parentChannelId);
  }),
);

it.effect("keeps the stored profile fields a chat update leaves out", () =>
  Effect.gen(function* () {
    let updated: OpenbotChannelUpdateInput | undefined;

    yield* useService(
      {
        update: (input) => {
          updated = input;
          return Effect.succeed(callerChannel);
        },
      },
      (service) => service.updateChat(scope, { expectedRevision: 0, name: "Garden notes" }),
    );

    assert.strictEqual(updated?.channelId, callerChannelId);
    assert.strictEqual(updated?.name, "Garden notes");
    assert.strictEqual(updated?.description, callerChannel.description);
    assert.deepStrictEqual(updated?.modelSelection, callerChannel.modelSelection);
  }),
);

it.effect("reads a named chat's profile before updating it", () =>
  Effect.gen(function* () {
    let updated: OpenbotChannelUpdateInput | undefined;

    yield* useService(
      {
        channelForThread: () => Effect.die("must not resolve the calling chat"),
        getView: (channelId) =>
          Effect.succeed(
            viewFor({ ...callerChannel, id: channelId, description: "Stored description." }),
          ),
        update: (input) => {
          updated = input;
          return Effect.succeed(callerChannel);
        },
      },
      (service) =>
        service.updateChat(scope, { channelId: otherChannelId, expectedRevision: 4, name: "Soil" }),
    );

    assert.strictEqual(updated?.channelId, otherChannelId);
    assert.strictEqual(updated?.description, "Stored description.");
  }),
);

it.effect("writes instructions without disturbing remembered knowledge", () =>
  Effect.gen(function* () {
    let written: OpenbotContextUpdateInput | undefined;

    yield* useService(
      {
        getContext: () =>
          Effect.succeed({
            threadId: callerThreadId,
            instructions: "Old instructions.",
            knowledge: "Beds are clay.",
            revision: 2,
          }),
        updateContext: (input) => {
          written = input;
          return Effect.succeed({
            threadId: callerThreadId,
            instructions: input.instructions,
            knowledge: input.knowledge,
            revision: input.expectedRevision + 1,
          });
        },
      },
      (service) =>
        service.updateInstructions(scope, {
          expectedRevision: 2,
          instructions: "Answer in Australian English.",
        }),
    );

    assert.strictEqual(written?.channelId, callerChannelId);
    assert.strictEqual(written?.instructions, "Answer in Australian English.");
    assert.strictEqual(written?.knowledge, "Beds are clay.");
  }),
);

// An agent that guesses an icon name gets a rejection instead of the fallback
// glyph, so it needs a way to find a real one without touching channel state.
it.effect(
  "answers an icon search from the shared catalog without calling the channel service",
  () =>
    Effect.gen(function* () {
      const result = yield* useService({}, (service) =>
        service.searchIcons(scope, { query: "plant", limit: 3 }),
      );

      assert.strictEqual(result.icons[0]?.name, "Plant");
      assert.strictEqual(result.icons[0]?.label, "Plant");
      assert.isAtMost(result.icons.length, 3);
      assert.isAtLeast(result.total, result.icons.length);
    }),
);

it.effect("maps service error codes onto the agent-facing failure codes", () =>
  Effect.gen(function* () {
    const cases = [
      { code: "project_not_found", expected: "not_found" },
      { code: "knowledge_not_found", expected: "not_found" },
      { code: "request_not_found", expected: "not_found" },
      { code: "knowledge_conflict", expected: "request_conflict" },
      { code: "peer_request_invalid", expected: "request_conflict" },
      { code: "orchestration_error", expected: "operation_failed" },
      { code: "no_provider_available", expected: "operation_failed" },
    ] as const;

    for (const testCase of cases) {
      const error = yield* useService(
        {
          getKnowledge: () =>
            Effect.fail(new OpenbotError({ code: testCase.code, message: "boom" })),
        },
        (service) => service.knowledgeRead(scope, { knowledgeId }),
      ).pipe(Effect.flip);

      assert.strictEqual(error.code, testCase.expected, testCase.code);
    }
  }),
);
