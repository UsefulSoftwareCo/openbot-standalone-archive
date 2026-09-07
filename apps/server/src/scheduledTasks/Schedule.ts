import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

const MINUTE_MS = 60_000;

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Cron schedules carry their own zone, so they are the only variant whose
 * firing times are independent of the server's local zone. The contract has
 * already rejected anything unparsable; a `null` here means a hand-edited or
 * corrupt row, which the callers treat as "cannot be scheduled".
 */
function parseCron(schedule: { expression: string; timeZone: string }): Cron.Cron | null {
  const parsed = Cron.parse(schedule.expression, schedule.timeZone);
  return Result.isSuccess(parsed) ? parsed.success : null;
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "interval") {
    // Persisted rows created before the one-minute floor remain readable, but
    // they must not retain their old high-frequency execution rate.
    return DateTime.add(from, {
      milliseconds: Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS),
    });
  }

  if (schedule.type === "cron") {
    const cron = parseCron(schedule);
    if (cron === null) return null;
    // `Cron.next` is strict: an instant that already matches yields the
    // following occurrence, so a completed run never re-fires immediately.
    return DateTime.makeUnsafe(Cron.next(cron, from));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

/**
 * Canonical form of a weekday mask, mirroring how `nextScheduledRunAt` reads
 * it: order and duplicates are irrelevant, and an empty/omitted mask means the
 * same as explicitly listing all seven days — daily.
 */
function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

/** Semantic equality for schedules: true iff both fire at the same times. */
export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "cron") {
    return (
      b.type === "cron" &&
      // Field separators are insignificant to cron, so a reformatted but
      // otherwise identical expression must not restart the clock.
      a.expression.split(/\s+/).join(" ") === b.expression.split(/\s+/).join(" ") &&
      a.timeZone === b.timeZone
    );
  }
  return (
    b.type === "fixed_time" &&
    a.timeOfDay === b.timeOfDay &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

/**
 * How late a wall-clock run may fire before it counts as missed. Covers poll
 * jitter and short sleeps, while a server booted hours after the slot skips
 * to the next occurrence instead of firing stale work at a random time.
 */
export const MISSED_WALL_CLOCK_GRACE_MS = 10 * MINUTE_MS;

/**
 * True when a due wall-clock run (fixed time or cron) was missed by more than
 * the grace window and should be rescheduled to its next occurrence instead of
 * firing now. Interval schedules are never considered missed: an overdue
 * interval task catching up with a single run is the desired behaviour.
 */
export function isMissedWallClockRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type === "interval") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_WALL_CLOCK_GRACE_MS;
}

export function describeSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / MINUTE_MS;
    if (Number.isInteger(minutes)) {
      return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
    }
    return `Every ${Math.round(schedule.everyMs / 1000)} seconds`;
  }

  if (schedule.type === "cron") {
    return `${schedule.expression} (${schedule.timeZone})`;
  }

  const weekdayCount = schedule.weekdays?.length ?? 0;
  const days =
    weekdayCount === 0
      ? "day"
      : weekdayCount === 5 && schedule.weekdays?.every((day) => day >= 1 && day <= 5)
        ? "weekday"
        : "selected day";
  return `At ${schedule.timeOfDay} every ${days}`;
}
