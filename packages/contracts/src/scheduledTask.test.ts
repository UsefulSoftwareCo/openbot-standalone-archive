import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

describe("cron schedules", () => {
  it("accepts 5-field expressions with an IANA zone", () => {
    for (const expression of ["0 */2 * * *", "0 9,12,16 * * 1-5", "9 8-19 * * 1-5", "41 * * * *"]) {
      expect(decodeUpsertSchedule({ type: "cron", expression, timeZone: "UTC" })).toEqual({
        type: "cron",
        expression,
        timeZone: "UTC",
      });
    }
    expect(
      decodeUpsertSchedule({
        type: "cron",
        expression: "  0 9 14 9 *  ",
        timeZone: " America/Los_Angeles ",
      }),
    ).toEqual({ type: "cron", expression: "0 9 14 9 *", timeZone: "America/Los_Angeles" });
  });

  it("reads cron schedules back through the persisted union", () => {
    expect(decodeSchedule({ type: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" })).toEqual({
      type: "cron",
      expression: "0 9 * * 1-5",
      timeZone: "UTC",
    });
  });

  it("rejects seconds and year cron variants so the one-minute floor holds", () => {
    // Six fields would be a seconds-precision cron, seven adds a year.
    expect(() =>
      decodeUpsertSchedule({ type: "cron", expression: "*/30 * * * * *", timeZone: "UTC" }),
    ).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "cron", expression: "0 0 9 * * 1-5 2026", timeZone: "UTC" }),
    ).toThrow();
  });

  it("rejects malformed expressions and unknown time zones", () => {
    expect(() =>
      decodeUpsertSchedule({ type: "cron", expression: "not a cron", timeZone: "UTC" }),
    ).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "cron", expression: "99 9 * * *", timeZone: "UTC" }),
    ).toThrow();
    expect(() => decodeUpsertSchedule({ type: "cron", expression: "", timeZone: "UTC" })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "cron", expression: "0 9 * * 1-5", timeZone: "Mars/Olympus" }),
    ).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "cron", expression: "0 9 * * 1-5", timeZone: "" }),
    ).toThrow();
  });
});
