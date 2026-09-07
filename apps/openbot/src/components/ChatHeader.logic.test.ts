import { describe, expect, it } from "@effect/vitest";

import { snoozeActive } from "./ChatHeader";

describe("snoozeActive", () => {
  const now = Date.parse("2026-04-10T12:00:00.000Z");

  it("is active only while the wake time is still ahead", () => {
    expect(snoozeActive("2026-04-10T13:00:00.000Z", now)).toBe(true);
    expect(snoozeActive("2026-04-10T12:00:00.000Z", now)).toBe(false);
    expect(snoozeActive("2026-04-10T11:00:00.000Z", now)).toBe(false);
  });

  it("treats a missing or malformed timestamp as awake", () => {
    expect(snoozeActive(null, now)).toBe(false);
    expect(snoozeActive("not a date", now)).toBe(false);
  });
});
