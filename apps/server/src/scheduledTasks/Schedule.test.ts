import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  describeSchedule,
  isMissedWallClockRun,
  isSameSchedule,
  nextScheduledRunAt,
  parseTimeOfDay,
} from "./Schedule.ts";

const isoOf = (value: DateTime.DateTime | null) =>
  value === null ? null : DateTime.formatIso(DateTime.toUtc(value));

describe("scheduled task schedule calculation", () => {
  it("parses 24-hour times", () => {
    expect(parseTimeOfDay("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("25:00")).toBeNull();
  });

  it("calculates interval schedules from the supplied instant", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 5 * 60_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:05:00.000Z");
  });

  it("clamps legacy sub-minute intervals to the one-minute execution floor", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 1_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:01:00.000Z");
  });

  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("calculates cron schedules in their own time zone", () => {
    const weekdayMorning = { type: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" } as const;
    // Friday 17:00Z: the next weekday slot is Monday, not Saturday.
    expect(
      isoOf(nextScheduledRunAt(weekdayMorning, DateTime.makeUnsafe("2026-03-06T17:00:00Z"))),
    ).toBe("2026-03-09T09:00:00.000Z");
    // An instant that already matches yields the following occurrence, so a
    // completed run cannot immediately re-fire.
    expect(
      isoOf(nextScheduledRunAt(weekdayMorning, DateTime.makeUnsafe("2026-03-09T09:00:00Z"))),
    ).toBe("2026-03-10T09:00:00.000Z");
    expect(
      isoOf(
        nextScheduledRunAt(
          { type: "cron", expression: "0 */2 * * *", timeZone: "UTC" },
          DateTime.makeUnsafe("2026-03-09T09:15:00Z"),
        ),
      ),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("keeps a zoned cron at the same wall-clock time across a DST boundary", () => {
    const laMornings = {
      type: "cron",
      expression: "0 9 * * 1-5",
      timeZone: "America/Los_Angeles",
    } as const;
    // Friday 2026-03-06 09:00 PST (UTC-8). The US spring-forward lands on
    // Sunday the 8th, so Monday's 09:00 is PDT (UTC-7) — one hour earlier in
    // UTC than the previous run. A fixed_time schedule in a server-local zone
    // could not express this without drifting.
    expect(isoOf(nextScheduledRunAt(laMornings, DateTime.makeUnsafe("2026-03-06T17:00:00Z")))).toBe(
      "2026-03-09T16:00:00.000Z",
    );
    // Friday 2026-10-30 09:00 PDT; fall-back is Sunday the 1st, so Monday's
    // 09:00 is PST again.
    expect(isoOf(nextScheduledRunAt(laMornings, DateTime.makeUnsafe("2026-10-30T16:00:00Z")))).toBe(
      "2026-11-02T17:00:00.000Z",
    );
  });

  it("returns no next run for a corrupt persisted cron row", () => {
    expect(
      nextScheduledRunAt(
        { type: "cron", expression: "not a cron", timeZone: "UTC" },
        DateTime.makeUnsafe("2026-03-06T17:00:00Z"),
      ),
    ).toBeNull();
  });

  it("skips wall-clock runs missed by more than the grace window", () => {
    const fixedTime = { type: "fixed_time", timeOfDay: "09:00" } as const;
    const cron = { type: "cron", expression: "0 9 * * *", timeZone: "UTC" } as const;
    const dueAt = DateTime.makeUnsafe("2026-07-01T09:00:00.000Z");
    const withinGrace = DateTime.makeUnsafe("2026-07-01T09:05:00.000Z");
    const pastGrace = DateTime.makeUnsafe("2026-07-01T15:00:00.000Z");
    // A run only slightly late (poll jitter, short sleep) still fires.
    expect(isMissedWallClockRun(fixedTime, dueAt, withinGrace)).toBe(false);
    // A run hours past its slot is skipped and rescheduled instead.
    expect(isMissedWallClockRun(fixedTime, dueAt, pastGrace)).toBe(true);
    // Cron names an exact instant just like fixed_time, so it skips too.
    expect(isMissedWallClockRun(cron, dueAt, withinGrace)).toBe(false);
    expect(isMissedWallClockRun(cron, dueAt, pastGrace)).toBe(true);
    // Interval schedules always catch up with a single run, never skip.
    expect(isMissedWallClockRun({ type: "interval", everyMs: 60_000 }, dueAt, pastGrace)).toBe(
      false,
    );
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    // Weekday masks are sets: order and duplicates do not change firing.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    // Omitted, empty, and all-seven masks all mean daily.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });

  it("compares cron schedules by expression and zone", () => {
    const cron = { type: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" } as const;
    expect(isSameSchedule(cron, { ...cron })).toBe(true);
    // Whitespace between fields is not part of the schedule.
    expect(isSameSchedule(cron, { ...cron, expression: "0  9 * *  1-5" })).toBe(true);
    expect(isSameSchedule(cron, { ...cron, expression: "0 10 * * 1-5" })).toBe(false);
    expect(isSameSchedule(cron, { ...cron, timeZone: "America/Los_Angeles" })).toBe(false);
    // A cron is never equal to the fixed_time or interval it resembles, so an
    // update that changes the variant always restarts the clock.
    expect(isSameSchedule(cron, { type: "fixed_time", timeOfDay: "09:00" })).toBe(false);
    expect(isSameSchedule({ type: "fixed_time", timeOfDay: "09:00" }, cron)).toBe(false);
    expect(isSameSchedule({ type: "interval", everyMs: 60_000 }, cron)).toBe(false);
  });

  it("describes cron schedules with their zone", () => {
    expect(describeSchedule({ type: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" })).toBe(
      "0 9 * * 1-5 (UTC)",
    );
  });
});
