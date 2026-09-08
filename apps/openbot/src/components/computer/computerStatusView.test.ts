import { describe, expect, it } from "@effect/vitest";
import {
  OpenbotComputerDisplayId,
  type OpenbotComputerDisplay,
  type OpenbotComputerStatus,
} from "@t3tools/contracts";

import {
  computerStatusView,
  controllerBadge,
  displayCountLabel,
  displayOptionLabel,
  displaySummary,
  permissionSummary,
  sessionLabel,
  setupSummary,
  streamBanner,
} from "./computerStatusView";

function display(overrides: Partial<OpenbotComputerDisplay> = {}): OpenbotComputerDisplay {
  return {
    id: OpenbotComputerDisplayId.make("1"),
    name: "Built-in Retina Display",
    kind: "physical",
    widthPx: 3456,
    heightPx: 2234,
    scale: 2,
    main: true,
    managed: false,
    ...overrides,
  };
}

function status(overrides: Partial<OpenbotComputerStatus> = {}): OpenbotComputerStatus {
  return {
    host: { label: "Studio", platform: "darwin" },
    session: "signed-in-desktop",
    availability: "ready",
    detail: null,
    permissions: { screenCapture: "granted", accessibility: "granted", detail: null },
    setup: null,
    capabilities: {
      stream: true,
      input: true,
      windows: true,
      focusWindow: true,
      managedDisplays: true,
      launchApp: true,
    },
    displays: [display()],
    windows: [],
    controller: null,
    lastCaptureAt: "2026-09-08T10:00:00.000Z",
    lastError: null,
    checkedAt: "2026-09-08T10:00:01.000Z",
    ...overrides,
  };
}

describe("sessionLabel", () => {
  it("names each kind of desktop without implying an isolated one", () => {
    expect(sessionLabel("signed-in-desktop")).toBe("Shared desktop");
    expect(sessionLabel("shared-x11-desktop")).toBe("Shared X11 desktop");
    expect(sessionLabel("managed-x11-session")).toBe("Managed X session");
    expect(sessionLabel("unsupported")).toBe("Unsupported");
  });
});

describe("display labels", () => {
  it("summarises the main display's resolution", () => {
    expect(
      displaySummary([
        display({ id: OpenbotComputerDisplayId.make("a"), main: false }),
        display({
          id: OpenbotComputerDisplayId.make("b"),
          widthPx: 5120,
          heightPx: 2880,
          main: true,
        }),
      ]),
    ).toBe("2 displays · 5120×2880");
  });

  it("falls back to the first display when none is marked main", () => {
    expect(displaySummary([display({ main: false })])).toBe("1 display · 3456×2234");
  });

  it("says so when the host reports no displays", () => {
    expect(displaySummary([])).toBe("No displays");
    expect(displayCountLabel([])).toBe("0 displays");
  });

  it("names one display in a picker", () => {
    expect(displayOptionLabel(display())).toBe("Built-in Retina Display · 3456×2234");
  });
});

describe("permissionSummary", () => {
  it("names each refused grant the way the system does", () => {
    expect(
      permissionSummary({ screenCapture: "denied", accessibility: "granted", detail: null }),
    ).toBe("Screen Recording not granted");
    expect(
      permissionSummary({ screenCapture: "granted", accessibility: "denied", detail: null }),
    ).toBe("Accessibility not granted");
    expect(
      permissionSummary({ screenCapture: "denied", accessibility: "denied", detail: null }),
    ).toBe("Screen Recording and Accessibility not granted");
  });

  it("stays quiet when nothing was refused", () => {
    expect(
      permissionSummary({
        screenCapture: "not-applicable",
        accessibility: "unknown",
        detail: null,
      }),
    ).toBeNull();
  });
});

describe("setupSummary", () => {
  it("names the tools to install", () => {
    expect(
      setupSummary({
        ready: false,
        dependencies: [
          { name: "Xvfb", present: false, path: null, install: "apt install xvfb" },
          { name: "xdotool", present: false, path: null, install: "apt install xdotool" },
          { name: "ffmpeg", present: true, path: "/usr/bin/ffmpeg", install: null },
        ],
        notes: [],
      }),
    ).toBe("Setup needed: install Xvfb, xdotool");
  });

  it("falls back to the host's own note when every tool is present", () => {
    expect(
      setupSummary({
        ready: false,
        dependencies: [{ name: "Xvfb", present: true, path: "/usr/bin/Xvfb", install: null }],
        notes: ["This session is Wayland-only; X11 forwarding is off."],
      }),
    ).toBe("This session is Wayland-only; X11 forwarding is off.");
  });

  it("says nothing when the host is ready", () => {
    expect(setupSummary(null)).toBeNull();
    expect(setupSummary({ ready: true, dependencies: [], notes: [] })).toBeNull();
  });
});

describe("computerStatusView", () => {
  it("reads as ready and streamable once the server has a real capture behind it", () => {
    const view = computerStatusView({ status: status(), statusError: null });
    expect(view).toMatchObject({ statusLabel: "Ready", dotClass: "bg-success", canStream: true });
    expect(view.reason).toBeNull();
  });

  it("never claims ready before a capture has succeeded, but still offers to try", () => {
    const view = computerStatusView({
      status: status({ availability: "unknown", lastCaptureAt: null }),
      statusError: null,
    });
    expect(view.statusLabel).toBe("Not checked");
    expect(view.canStream).toBe(true);
  });

  it("leads with the refused permission and refuses to stream", () => {
    const view = computerStatusView({
      status: status({
        availability: "unavailable",
        detail: "Capture returned a black frame.",
        permissions: { screenCapture: "denied", accessibility: "granted", detail: null },
      }),
      statusError: null,
    });
    expect(view.reason).toBe("Screen Recording not granted");
    expect(view.canStream).toBe(false);
  });

  it("leads with missing host tools when permissions are fine", () => {
    const view = computerStatusView({
      status: status({
        host: { label: "box", platform: "linux" },
        session: "managed-x11-session",
        availability: "unavailable",
        permissions: {
          screenCapture: "not-applicable",
          accessibility: "not-applicable",
          detail: null,
        },
        setup: {
          ready: false,
          dependencies: [{ name: "Xvfb", present: false, path: null, install: "apt install xvfb" }],
          notes: [],
        },
      }),
      statusError: null,
    });
    expect(view.reason).toBe("Setup needed: install Xvfb");
    expect(view.canStream).toBe(false);
  });

  it("uses the host's own words on an unsupported platform", () => {
    const view = computerStatusView({
      status: status({
        session: "unsupported",
        availability: "unsupported",
        detail: "This session is Wayland-only.",
        capabilities: {
          stream: false,
          input: false,
          windows: false,
          focusWindow: false,
          managedDisplays: false,
          launchApp: false,
        },
        displays: [],
      }),
      statusError: null,
    });
    expect(view.reason).toBe("This session is Wayland-only.");
    expect(view.canStream).toBe(false);
  });

  it("will not stream a host that reports no displays", () => {
    expect(
      computerStatusView({ status: status({ displays: [] }), statusError: null }).canStream,
    ).toBe(false);
  });

  it("distinguishes a status that has not arrived from one that failed", () => {
    expect(computerStatusView({ status: null, statusError: null })).toMatchObject({
      statusLabel: "Checking…",
      canStream: false,
      reason: null,
    });
    expect(computerStatusView({ status: null, statusError: "Connection closed" })).toMatchObject({
      statusLabel: "Unreachable",
      reason: "Connection closed",
    });
  });
});

describe("controllerBadge", () => {
  it("says who is controlling, including an agent", () => {
    expect(
      controllerBadge({ kind: "viewer", label: "You", since: "2026-09-08T10:00:00.000Z" }, true),
    ).toBe("You're controlling");
    expect(
      controllerBadge({ kind: "viewer", label: "iPad", since: "2026-09-08T10:00:00.000Z" }, false),
    ).toBe("iPad is controlling");
    expect(
      controllerBadge(
        { kind: "agent", label: "Groceries", since: "2026-09-08T10:00:00.000Z" },
        false,
      ),
    ).toBe("Agent input active");
  });

  it("says nothing when the session is idle", () => {
    expect(controllerBadge(null, false)).toBeNull();
  });
});

describe("streamBanner", () => {
  const base = { connection: "open", status: null, message: null, hasFrame: true } as const;

  it("stays out of the way while frames are arriving", () => {
    expect(streamBanner({ ...base, status: "capturing" })).toBeNull();
  });

  it("prefers the server's answer over the socket's own state", () => {
    expect(
      streamBanner({
        connection: "closed",
        status: "superseded",
        message: null,
        hasFrame: true,
      }),
    ).toEqual({ text: "Another viewer took over this display.", tone: "warning" });
  });

  it("uses the host's message when it sent one", () => {
    expect(
      streamBanner({ ...base, status: "permission-denied", message: "Screen Recording is off." }),
    ).toEqual({ text: "Screen Recording is off.", tone: "warning" });
  });

  it("shows the retry, and says nothing extra once a frame is on screen", () => {
    expect(streamBanner({ ...base, connection: "reconnecting" })?.tone).toBe("warning");
    expect(streamBanner({ ...base, connection: "connecting", hasFrame: false })?.text).toBe(
      "Connecting to the host's screen…",
    );
    expect(streamBanner({ ...base, connection: "connecting" })).toBeNull();
  });
});
