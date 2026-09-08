import { describe, expect, it } from "@effect/vitest";

import {
  type MaximizeEvent,
  type MaximizeState,
  NOT_MAXIMIZED,
  denialHint,
  nextMaximizeState,
} from "./computerMaximize";

function run(...events: ReadonlyArray<MaximizeEvent>): MaximizeState {
  return events.reduce(nextMaximizeState, NOT_MAXIMIZED);
}

describe("nextMaximizeState", () => {
  it("fills the viewport on click, before the browser has answered", () => {
    expect(run({ type: "clickMaximize" })).toEqual({
      maximized: true,
      native: false,
      hint: null,
    });
  });

  it("upgrades to native fullscreen when the browser grants it", () => {
    expect(run({ type: "clickMaximize" }, { type: "nativeGranted" })).toEqual({
      maximized: true,
      native: true,
      hint: null,
    });
  });

  it("stays maximized in the page with a hint when the browser declines", () => {
    expect(run({ type: "clickMaximize" }, { type: "nativeDenied", reason: "declined" })).toEqual({
      maximized: true,
      native: false,
      hint: denialHint("declined"),
    });
  });

  it("stays maximized in the page when the browser has no fullscreen API", () => {
    const state = run({ type: "clickMaximize" }, { type: "nativeDenied", reason: "unsupported" });
    expect(state.maximized).toBe(true);
    expect(state.native).toBe(false);
    expect(state.hint).toBe("This browser has no fullscreen API");
  });

  it("clears the hint when the user leaves and maximizes again", () => {
    expect(
      run(
        { type: "clickMaximize" },
        { type: "nativeDenied", reason: "declined" },
        { type: "clickExit" },
        { type: "clickMaximize" },
      ),
    ).toEqual({ maximized: true, native: false, hint: null });
  });

  it("leaves the overlay when the browser leaves fullscreen on its own", () => {
    expect(
      run({ type: "clickMaximize" }, { type: "nativeGranted" }, { type: "nativeExited" }),
    ).toEqual(NOT_MAXIMIZED);
  });

  it("ignores a fullscreen exit the in-app overlay never entered", () => {
    const denied = run({ type: "clickMaximize" }, { type: "nativeDenied", reason: "declined" });
    expect(nextMaximizeState(denied, { type: "nativeExited" })).toBe(denied);
  });

  it("ignores Escape while this client is controlling the host", () => {
    const native = run({ type: "clickMaximize" }, { type: "nativeGranted" });
    expect(nextMaximizeState(native, { type: "escape", controlling: true })).toBe(native);
  });

  it("leaves on Escape while only watching", () => {
    expect(
      run(
        { type: "clickMaximize" },
        { type: "nativeGranted" },
        {
          type: "escape",
          controlling: false,
        },
      ),
    ).toEqual(NOT_MAXIMIZED);
  });

  it("ignores Escape and the exit button when nothing is maximized", () => {
    expect(nextMaximizeState(NOT_MAXIMIZED, { type: "escape", controlling: false })).toBe(
      NOT_MAXIMIZED,
    );
    expect(run({ type: "clickExit" })).toEqual(NOT_MAXIMIZED);
  });

  it("drops a native answer that arrives after the user has left", () => {
    const left = run({ type: "clickMaximize" }, { type: "clickExit" });
    expect(nextMaximizeState(left, { type: "nativeGranted" })).toBe(left);
    expect(nextMaximizeState(left, { type: "nativeDenied", reason: "declined" })).toBe(left);
  });

  it("keeps native fullscreen when the button is somehow clicked again", () => {
    const native = run({ type: "clickMaximize" }, { type: "nativeGranted" });
    expect(nextMaximizeState(native, { type: "clickMaximize" })).toBe(native);
  });
});
