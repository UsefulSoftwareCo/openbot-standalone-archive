import { describe, expect, it } from "@effect/vitest";

import { autoRefreshActive, displaySummary } from "./ComputerPanel";

describe("displaySummary", () => {
  it("names the main display's resolution", () => {
    expect(
      displaySummary([
        { id: "a", name: "DELL U2720Q", widthPx: 3840, heightPx: 2160, main: false },
        { id: "b", name: "Studio Display", widthPx: 5120, heightPx: 2880, main: true },
      ]),
    ).toBe("2 displays · 5120×2880");
  });

  it("falls back to the first display when none is marked main", () => {
    expect(
      displaySummary([{ id: "a", name: "Built-in", widthPx: 3840, heightPx: 2160, main: false }]),
    ).toBe("1 display · 3840×2160");
  });

  it("reports the count alone when the host gave no pixel size", () => {
    expect(
      displaySummary([{ id: "a", name: "Sidecar", widthPx: null, heightPx: null, main: true }]),
    ).toBe("1 display");
  });

  it("says so when the display list could not be read", () => {
    expect(displaySummary(null)).toBe("Unknown displays");
    expect(displaySummary([])).toBe("Unknown displays");
  });
});

describe("autoRefreshActive", () => {
  it("captures only while enabled, showing, and visible", () => {
    expect(autoRefreshActive({ enabled: true, showing: true, visibility: "visible" })).toBe(true);
    expect(autoRefreshActive({ enabled: true, showing: true, visibility: "hidden" })).toBe(false);
    expect(autoRefreshActive({ enabled: true, showing: false, visibility: "visible" })).toBe(false);
    expect(autoRefreshActive({ enabled: false, showing: true, visibility: "visible" })).toBe(false);
  });
});
