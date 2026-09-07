import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { layer as scheduledTaskLayer, ScheduledTaskService } from "./ScheduledTaskService.ts";

const PROJECT_ID = ProjectId.make("project:scheduled-task-cron");
const THREAD_ID = ThreadId.make("thread:scheduled-task-cron");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

/** Weekday 09:00 UTC. Under `it.effect` the clock starts at the epoch, a Thursday. */
const WEEKDAY_MORNINGS = { type: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" } as const;

function upsertInput(overrides: Partial<ScheduledTaskUpsertInput> = {}): ScheduledTaskUpsertInput {
  return {
    title: "Morning digest",
    prompt: "Summarize overnight activity.",
    enabled: true,
    schedule: WEEKDAY_MORNINGS,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("claude-agent"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  };
}

/**
 * The service only inspects whether a dispatch succeeded, so the send result is
 * a fixture cast rather than a whole synthetic projection.
 */
function makeHarness() {
  const dispatchedPrompts: string[] = [];
  const layer = scheduledTaskLayer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            dispatchedPrompts.push(input.text);
            return { delivery: "started" } as ThreadManagementService.ThreadManagementSendResult;
          }),
      }),
    ),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
    Layer.provide(
      Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  );
  return { dispatchedPrompts, layer };
}

describe("ScheduledTaskService cron schedules", () => {
  it.effect("persists a cron schedule and aims it at the next occurrence", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* ScheduledTaskService;
      const { task } = yield* service.upsert(upsertInput());
      expect(task.schedule).toEqual(WEEKDAY_MORNINGS);
      // The epoch is a Thursday, so the first weekday slot is later the same day.
      expect(task.nextRunAt).toBe("1970-01-01T09:00:00.000Z");

      // The persisted row round-trips through the read model unchanged.
      const { tasks } = yield* service.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.schedule).toEqual(WEEKDAY_MORNINGS);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the pending run when an edit leaves the cron alone", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* ScheduledTaskService;
      const created = yield* service.upsert(upsertInput());

      // Editing the prompt must not postpone the pending run, even though the
      // expression is re-sent with different whitespace.
      const renamed = yield* service.upsert(
        upsertInput({
          id: created.task.id,
          prompt: "Summarize overnight activity in detail.",
          schedule: { type: "cron", expression: "0  9 * *  1-5", timeZone: "UTC" },
        }),
      );
      expect(renamed.task.nextRunAt).toBe(created.task.nextRunAt);

      // A different expression is a different schedule and restarts the clock.
      const rescheduled = yield* service.upsert(
        upsertInput({
          id: created.task.id,
          schedule: { type: "cron", expression: "0 17 * * 1-5", timeZone: "UTC" },
        }),
      );
      expect(rescheduled.task.nextRunAt).toBe("1970-01-01T17:00:00.000Z");

      // So is the same expression in a different zone: 17:00 in Tokyo (UTC+9,
      // no DST) is 08:00 UTC, before the same wall-clock time in UTC.
      const rezoned = yield* service.upsert(
        upsertInput({
          id: created.task.id,
          schedule: { type: "cron", expression: "0 17 * * 1-5", timeZone: "Asia/Tokyo" },
        }),
      );
      expect(rezoned.task.nextRunAt).toBe("1970-01-01T08:00:00.000Z");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fires a due cron run from the poll loop and re-arms it once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* ScheduledTaskService.pipe(Effect.flatMap((service) => service.upsert(upsertInput())));
      // Cross Thursday's 09:00 slot and stop before Friday's, so the poller has
      // every opportunity to double-fire if the re-arm were wrong.
      yield* TestClock.adjust("24 hours");

      expect(harness.dispatchedPrompts).toEqual([
        "[Triggered by schedule task: Morning digest]\n\nSummarize overnight activity.",
      ]);
      const service = yield* ScheduledTaskService;
      const { tasks } = yield* service.list();
      const task = tasks[0];
      expect(task?.lastRunStatus).toBe("succeeded");
      expect(task?.runCount).toBe(1);
      expect(task?.lastRunAt).toBe("1970-01-01T09:00:00.000Z");
      // Friday 09:00 UTC: the completed run advanced past its own slot.
      expect(task?.nextRunAt).toBe("1970-01-02T09:00:00.000Z");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("runs a cron task on demand without disturbing its schedule", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* ScheduledTaskService;
      const created = yield* service.upsert(upsertInput());
      const { task } = yield* service.runNow({ id: created.task.id });
      expect(harness.dispatchedPrompts).toHaveLength(1);
      expect(task.lastRunStatus).toBe("succeeded");
      expect(task.runCount).toBe(1);
      // A manual run does not consume the pending occurrence.
      expect(task.nextRunAt).toBe("1970-01-01T09:00:00.000Z");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clears and restores the next run when a cron task is paused", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* ScheduledTaskService;
      const created = yield* service.upsert(upsertInput());
      const paused = yield* service.setEnabled({ id: created.task.id, enabled: false });
      expect(paused.task.nextRunAt).toBeNull();
      const resumed = yield* service.setEnabled({ id: created.task.id, enabled: true });
      expect(resumed.task.nextRunAt).toBe("1970-01-01T09:00:00.000Z");
    }).pipe(Effect.provide(harness.layer));
  });
});
