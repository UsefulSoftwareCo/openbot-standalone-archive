import { describe, expect, it } from "@effect/vitest";

import type { OpenbotComputerStatus } from "@t3tools/contracts";

import { autoRefreshActive, computerStateView, displaySummary } from "./ComputerPanel";

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

function status(overrides: Partial<OpenbotComputerStatus>): OpenbotComputerStatus {
  return {
    host: { label: "Studio", platform: "darwin" },
    session: "signed-in-desktop",
    availability: "unknown",
    detail: null,
    displays: null,
    lastCaptureAt: null,
    lastError: null,
    checkedAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

describe("computerStateView", () => {
  it("never reads as ready before a capture has succeeded", () => {
    const view = computerStateView({ status: status({}), statusError: null });
    expect(view.label).toBe("Not checked");
    expect(view.canCapture).toBe(true);
  });

  it("reads as ready once the server has a real capture behind it", () => {
    const view = computerStateView({
      status: status({ availability: "ready", lastCaptureAt: "2026-09-07T09:59:00.000Z" }),
      statusError: null,
    });
    expect(view.label).toBe("Ready");
    expect(view.dotClass).toBe("bg-success");
    expect(view.canCapture).toBe(true);
  });

  it("offers a retry after a capture failed, but not when the host simply cannot", () => {
    const refused = computerStateView({
      status: status({ availability: "unavailable", lastError: "could not create image" }),
      statusError: null,
    });
    expect(refused.label).toBe("Unavailable");
    expect(refused.canCapture).toBe(true);

    const missingTool = computerStateView({
      status: status({ availability: "unavailable", detail: "no screencapture" }),
      statusError: null,
    });
    expect(missingTool.canCapture).toBe(false);
  });

  it("offers nothing on an unsupported platform or an unreachable server", () => {
    expect(
      computerStateView({ status: status({ availability: "unsupported" }), statusError: null }),
    ).toMatchObject({ label: "Unsupported", canCapture: false });
    expect(computerStateView({ status: null, statusError: null }).label).toBe("Checking…");
    expect(computerStateView({ status: null, statusError: "closed" })).toMatchObject({
      label: "Unreachable",
      canCapture: false,
    });
  });
});
