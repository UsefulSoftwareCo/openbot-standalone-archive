import { describe, expect, it } from "@effect/vitest";

import { detectLinuxSession, WAYLAND_REASON, XWAYLAND_NOTE } from "./LinuxSessionDetect.ts";

describe("detectLinuxSession", () => {
  it("shares the X desktop DISPLAY points at", () => {
    expect(detectLinuxSession({ DISPLAY: ":0" })).toEqual({
      kind: "shared-x11",
      display: ":0",
      xauthority: null,
      notes: [],
    });
  });

  it("carries the cookie file through so a locked X server still answers", () => {
    const detected = detectLinuxSession({
      DISPLAY: ":0",
      XAUTHORITY: "/run/user/1000/gdm/Xauthority",
    });
    expect(detected).toMatchObject({
      kind: "shared-x11",
      xauthority: "/run/user/1000/gdm/Xauthority",
    });
  });

  it("treats an XWayland display as shareable, and says what is missing from it", () => {
    const detected = detectLinuxSession({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_SESSION_TYPE: "wayland",
    });
    expect(detected).toEqual({
      kind: "shared-x11",
      display: ":0",
      xauthority: null,
      notes: [XWAYLAND_NOTE],
    });
  });

  it("reports a Wayland session with no X display as unsupported, with the reason", () => {
    expect(detectLinuxSession({ WAYLAND_DISPLAY: "wayland-0" })).toEqual({
      kind: "wayland-only",
      reason: WAYLAND_REASON,
    });
    expect(detectLinuxSession({ XDG_SESSION_TYPE: "Wayland" })).toEqual({
      kind: "wayland-only",
      reason: WAYLAND_REASON,
    });
  });

  it("calls a host with no desktop headless, which is where a managed session belongs", () => {
    expect(detectLinuxSession({})).toEqual({ kind: "headless" });
    expect(detectLinuxSession({ XDG_SESSION_TYPE: "tty" })).toEqual({ kind: "headless" });
  });

  it("ignores blank values rather than treating them as a display", () => {
    expect(detectLinuxSession({ DISPLAY: "  ", WAYLAND_DISPLAY: "" })).toEqual({
      kind: "headless",
    });
    expect(detectLinuxSession({ DISPLAY: ":0", XAUTHORITY: "  " })).toMatchObject({
      xauthority: null,
    });
  });
});
