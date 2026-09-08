import cronstrue from "cronstrue";
import { Cron, Result } from "effect";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EN_DASH = "–";

/** Cron leaves a field's set empty for `*`; a fully enumerated field means the same thing. */
function unrestricted(values: ReadonlySet<number>, count: number): boolean {
  return values.size === 0 || values.size === count;
}

/** The field's values in order, expanded to the whole range when unrestricted. */
function expand(values: ReadonlySet<number>, min: number, count: number): number[] {
  if (unrestricted(values, count)) return Array.from({ length: count }, (_, index) => min + index);
  return [...values].sort((a, b) => a - b);
}

function isConsecutive(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value === values[index - 1]! + 1);
}

/**
 * The step of a stepped wildcard field: values starting at 0, evenly spaced,
 * and covering the whole range. Anything else (a step of 7 minutes, or
 * `5,10,20`) leaves an uneven gap at the wrap, so calling it "every n" would
 * misstate the schedule.
 */
function wrappingStep(values: readonly number[], count: number): number | undefined {
  const step = count / values.length;
  if (values.length < 2 || !Number.isInteger(step) || values[0] !== 0) return undefined;
  return values.every((value, index) => value === index * step) ? step : undefined;
}

/** `9am`, `12:30pm`, `8:09am` — the way a person writes a time, not `09:00 AM`. */
function clock(hour: number, minute: number): string {
  const half = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "am" : "pm";
  return minute === 0
    ? `${half}${meridiem}`
    : `${half}:${String(minute).padStart(2, "0")}${meridiem}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * How often the routine runs within a day. `at` reads as "<days> at <times>",
 * `interval` as "<lead><days>, <window>". Undefined when no short phrase says
 * the same thing as the expression.
 */
type TimeSummary =
  | { readonly kind: "at"; readonly times: readonly string[] }
  | { readonly kind: "interval"; readonly lead: string; readonly window?: string };

function summarizeTime(
  minutes: ReadonlySet<number>,
  hours: ReadonlySet<number>,
): TimeSummary | undefined {
  const everyMinute = unrestricted(minutes, 60);
  const everyHour = unrestricted(hours, 24);
  const minuteValues = expand(minutes, 0, 60);
  const hourValues = expand(hours, 0, 24);

  // A handful of fixed clock times is always clearer spelled out.
  if (!everyMinute && !everyHour && minuteValues.length * hourValues.length <= 3) {
    const times = hourValues.flatMap((hour) => minuteValues.map((minute) => clock(hour, minute)));
    return { kind: "at", times };
  }

  if (minuteValues.length === 1) {
    const minute = minuteValues[0]!;
    const past = minute === 0 ? "" : ` at :${String(minute).padStart(2, "0")}`;
    if (everyHour) return { kind: "interval", lead: `Every hour${past}` };
    const step = wrappingStep(hourValues, 24);
    if (step !== undefined) return { kind: "interval", lead: `Every ${step} hours${past}` };
    if (!isConsecutive(hourValues)) return undefined;
    return {
      kind: "interval",
      lead: "Every hour",
      window: `${clock(hourValues[0]!, minute)}${EN_DASH}${clock(hourValues.at(-1)!, minute)}`,
    };
  }

  const step = everyMinute ? 1 : wrappingStep(minuteValues, 60);
  if (step === undefined) return undefined;
  const lead = step === 1 ? "Every minute" : `Every ${step} minutes`;
  if (everyHour) return { kind: "interval", lead };
  if (!isConsecutive(hourValues)) return undefined;
  const start = clock(hourValues[0]!, minuteValues[0]!);
  const end = clock(hourValues.at(-1)!, minuteValues.at(-1)!);
  return { kind: "interval", lead, window: `${start}${EN_DASH}${end}` };
}

/**
 * Which days the routine runs on. `lead` opens a sentence ("Weekdays at 9am"),
 * `qualifier` trails an interval ("Every hour on weekdays"); it is undefined
 * when the schedule runs every day and needs no mention at all.
 */
type DaySummary = { readonly lead: string; readonly qualifier?: string };

function summarizeDays(
  days: ReadonlySet<number>,
  months: ReadonlySet<number>,
  weekdays: ReadonlySet<number>,
): DaySummary | undefined {
  // Cron ORs a restricted day-of-month with a restricted day-of-week, and no
  // short label says that without lying about one of them.
  if (days.size > 0 && weekdays.size > 0) return undefined;

  if (!unrestricted(months, 12)) {
    // Only a single calendar date stays short; "in Jan, Feb, and Mar on the
    // 3rd" is longer than the prose it would replace.
    if (months.size !== 1 || days.size !== 1) return undefined;
    const date = `${MONTH_NAMES[[...months][0]! - 1]} ${[...days][0]}`;
    return { lead: `Every ${date}`, qualifier: ` on ${date}` };
  }

  if (!unrestricted(days, 31)) {
    if (days.size > 3) return undefined;
    const dates = list([...days].sort((a, b) => a - b).map(ordinal));
    return {
      lead: `On the ${dates} of every month`,
      qualifier: ` on the ${dates} of every month`,
    };
  }

  if (unrestricted(weekdays, 7)) return { lead: "Every day" };

  const values = [...weekdays].sort((a, b) => a - b);
  const matches = (expected: readonly number[]) =>
    values.length === expected.length && values.every((value, index) => value === expected[index]);
  if (matches([1, 2, 3, 4, 5])) return { lead: "Weekdays", qualifier: " on weekdays" };
  if (matches([0, 6])) return { lead: "Weekends", qualifier: " on weekends" };
  if (values.length >= 4 && isConsecutive(values)) {
    const span = `${WEEKDAY_SHORT[values[0]!]}${EN_DASH}${WEEKDAY_SHORT[values.at(-1)!]}`;
    return { lead: span, qualifier: `, ${span}` };
  }
  if (values.length > 3) return undefined;
  return {
    lead: `Every ${list(values.map((value) => WEEKDAY_NAMES[value]!))}`,
    qualifier: `, ${list(values.map((value) => WEEKDAY_SHORT[value]!))}`,
  };
}

function compactLabel(cron: Cron.Cron): string | undefined {
  const day = summarizeDays(cron.days, cron.months, cron.weekdays);
  const time = summarizeTime(cron.minutes, cron.hours);
  if (day === undefined || time === undefined) return undefined;
  if (time.kind === "at") return `${day.lead} at ${list(time.times)}`;
  const window = time.window === undefined ? "" : `, ${time.window}`;
  return `${time.lead}${day.qualifier ?? ""}${window}`;
}

/**
 * Renders a cron expression as a short human label for the routine list and
 * the cron editor preview, falling back to full prose for shapes no short
 * label captures. Returns undefined for anything we cannot describe, so
 * callers can fall back to the raw expression or an honest placeholder while
 * the user is still typing.
 */
export function describeCron(expression: string): string | undefined {
  const trimmed = expression.trim();
  // Cron also speaks 6-field (seconds) expressions, but the server only
  // accepts five fields, so describing a sixth would advertise syntax that
  // fails.
  if (trimmed.length === 0 || trimmed.split(/\s+/).length !== 5) return undefined;
  const parsed = Cron.parse(trimmed);
  if (Result.isFailure(parsed)) return undefined;
  const compact = compactLabel(parsed.success);
  if (compact !== undefined) return compact;
  try {
    return cronstrue.toString(trimmed, { use24HourTimeFormat: false, verbose: false });
  } catch {
    return undefined;
  }
}
