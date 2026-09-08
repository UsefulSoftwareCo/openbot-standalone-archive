import { describe, expect, it } from "vite-plus/test";

import { describeCron } from "./cronDescription";

describe("describeCron", () => {
  it("names the days a schedule runs on", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 9am");
    expect(describeCron("0 9 * * 0,6")).toBe("Weekends at 9am");
    expect(describeCron("0 9 * * 1,3,5")).toBe("Every Monday, Wednesday, and Friday at 9am");
    expect(describeCron("0 9 * * 1-4")).toBe("Mon–Thu at 9am");
    expect(describeCron("0 9 1,15 * *")).toBe("On the 1st and 15th of every month at 9am");
    expect(describeCron("0 0 1 1 *")).toBe("Every January 1 at 12am");
    // An explicitly enumerated weekday field means the same as `*`.
    expect(describeCron("0 9 * * 0-6")).toBe("Every day at 9am");
  });

  it("writes clock times the way a person would", () => {
    expect(describeCron("0 9,17 * * *")).toBe("Every day at 9am and 5pm");
    expect(describeCron("30 12 * * *")).toBe("Every day at 12:30pm");
    expect(describeCron("9 8 * * *")).toBe("Every day at 8:09am");
  });

  it("describes repeating schedules as intervals, with their window", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("30 * * * *")).toBe("Every hour at :30");
    expect(describeCron("0 */2 * * *")).toBe("Every 2 hours");
    expect(describeCron("0 9-17 * * *")).toBe("Every hour, 9am–5pm");
    expect(describeCron("9 8-19 * * 1-5")).toBe("Every hour on weekdays, 8:09am–7:09pm");
    expect(describeCron("*/10 9-17 * * 1-5")).toBe("Every 10 minutes on weekdays, 9am–5:50pm");
  });

  // A short label has to mean exactly what the expression means. When it
  // cannot, full prose is better than a label that quietly drops a field.
  it("falls back to prose for shapes no short label captures", () => {
    // Cron ORs day-of-month with day-of-week, which no compact phrasing says.
    expect(describeCron("0 9 1 * 1")).toBe("At 09:00 AM, on day 1 of the month, and on Monday");
    expect(describeCron("0 9,17 * 1-3 *")).toBe("At 09:00 AM and 05:00 PM, January through March");
    // Unevenly spaced minutes are not "every n minutes".
    expect(describeCron("5,10,20,40 * * * *")).toBe("At 5, 10, 20, and 40 minutes past the hour");
  });

  // The editor calls this on every keystroke, so half-typed input is the
  // common case, not an edge case.
  it("returns undefined for input it cannot honestly describe", () => {
    expect(describeCron("")).toBeUndefined();
    expect(describeCron("0 9 * *")).toBeUndefined();
    expect(describeCron("0 9 * * 1-")).toBeUndefined();
    expect(describeCron("0 9, * * *")).toBeUndefined();
    expect(describeCron("foo bar baz qux quux")).toBeUndefined();
    // Cron accepts a sixth seconds field, but the server takes five.
    expect(describeCron("0 0 9 * * 1-5")).toBeUndefined();
  });
});
