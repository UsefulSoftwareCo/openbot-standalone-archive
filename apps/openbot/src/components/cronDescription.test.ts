import { describe, expect, it } from "vite-plus/test";

import { describeCron } from "./cronDescription";

describe("describeCron", () => {
  it("describes weekday and hour-range schedules in English", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("At 09:00 AM, Monday through Friday");
    expect(describeCron("9 8-19 * * 1-5")).toBe(
      "At 9 minutes past the hour, between 08:00 AM and 07:59 PM, Monday through Friday",
    );
  });

  it("describes lists, steps, and day-of-month schedules", () => {
    expect(describeCron("0 9,17 * * *")).toBe("At 09:00 AM and 05:00 PM");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 0 1 1 *")).toBe("At 12:00 AM, on day 1 of the month, only in January");
  });

  // The editor calls this on every keystroke, so half-typed input is the
  // common case, not an edge case.
  it("returns undefined for input it cannot honestly describe", () => {
    expect(describeCron("")).toBeUndefined();
    expect(describeCron("0 9 * *")).toBeUndefined();
    expect(describeCron("0 9 * * 1-")).toBeUndefined();
    expect(describeCron("0 9, * * *")).toBeUndefined();
    expect(describeCron("foo bar baz qux quux")).toBeUndefined();
    // cronstrue would read this as a seconds field, but the server takes five.
    expect(describeCron("0 0 9 * * 1-5")).toBeUndefined();
  });
});
