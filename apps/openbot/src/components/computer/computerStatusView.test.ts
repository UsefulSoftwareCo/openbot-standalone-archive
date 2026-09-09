import { describe, expect, it } from "@effect/vitest";
import {
  OpenbotChannelId,
  OpenbotComputerDisplayId,
  type OpenbotChatComputer,
  type OpenbotComputerDisplay,
} from "@t3tools/contracts";

import { chatComputerView, controllerBadge, streamBanner } from "./computerStatusView";

function display(overrides: Partial<OpenbotComputerDisplay> = {}): OpenbotComputerDisplay {
  return {
    id: OpenbotComputerDisplayId.make("1"),
    name: "Groceries",
    kind: "managed-virtual",
    widthPx: 1680,
    heightPx: 1050,
    scale: 2,
    main: false,
    managed: true,
    ...overrides,
  };
}

function computer(overrides: Partial<OpenbotChatComputer> = {}): OpenbotChatComputer {
  return {
    channelId: OpenbotChannelId.make("openbot-channel:groceries"),
    channelName: "Groceries",
    state: "ready",
    display: display(),
    detail: null,
    windows: [],
    controller: null,
    canLaunch: true,
    checkedAt: "2026-09-08T10:00:01.000Z",
    ...overrides,
  };
}

describe("chatComputerView", () => {
  it("reads as live and streamable once the chat's display exists", () => {
    const view = chatComputerView({ computer: computer(), error: null });
    expect(view).toEqual({
      statusLabel: "Live",
      dotClass: "bg-success",
      placeholder: null,
      canStream: true,
    });
  });

  it("keeps a standing caveat visible while the screen is live", () => {
    const view = chatComputerView({
      computer: computer({ detail: "This host has one pointer; agents share it." }),
      error: null,
    });
    expect(view.canStream).toBe(true);
    expect(view.placeholder).toBe("This host has one pointer; agents share it.");
  });

  it("says whose screen is being set up before there is one", () => {
    expect(
      chatComputerView({ computer: computer({ state: "idle", display: null }), error: null }),
    ).toMatchObject({
      statusLabel: "Not started",
      placeholder: "Setting up Groceries's screen…",
      canStream: false,
    });
    expect(
      chatComputerView({
        computer: computer({ state: "provisioning", display: null }),
        error: null,
      }),
    ).toMatchObject({ statusLabel: "Setting up", canStream: false });
  });

  it("falls back to the chat rather than an empty possessive", () => {
    expect(
      chatComputerView({
        computer: computer({ channelName: "  ", state: "provisioning", display: null }),
        error: null,
      }).placeholder,
    ).toBe("Setting up this chat's screen…");
  });

  it("uses the host's own words when the computer is unavailable", () => {
    const view = chatComputerView({
      computer: computer({
        state: "unavailable",
        display: null,
        detail: "This session is Wayland-only.",
      }),
      error: null,
    });
    expect(view).toMatchObject({
      statusLabel: "Unavailable",
      dotClass: "bg-warning",
      placeholder: "This session is Wayland-only.",
      canStream: false,
    });
  });

  it("says something honest when the host gave no reason", () => {
    expect(
      chatComputerView({
        computer: computer({ state: "unavailable", display: null, detail: null }),
        error: null,
      }).placeholder,
    ).toBe("Groceries's screen is not available right now.");
  });

  it("will not stream a ready answer that carries no display", () => {
    expect(chatComputerView({ computer: computer({ display: null }), error: null })).toMatchObject({
      statusLabel: "Live",
      placeholder: "Waiting for Groceries's screen…",
      canStream: false,
    });
  });

  it("distinguishes an answer that has not arrived from one that failed", () => {
    expect(chatComputerView({ computer: null, error: null })).toEqual({
      statusLabel: "Checking…",
      dotClass: "bg-muted-foreground",
      placeholder: null,
      canStream: false,
    });
    expect(chatComputerView({ computer: null, error: "Connection closed" })).toMatchObject({
      statusLabel: "Unreachable",
      placeholder: "Connection closed",
      canStream: false,
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
    ).toEqual({ text: "Another viewer took over this screen.", tone: "warning" });
  });

  it("uses the host's message when it sent one", () => {
    expect(
      streamBanner({ ...base, status: "permission-denied", message: "Screen Recording is off." }),
    ).toEqual({ text: "Screen Recording is off.", tone: "warning" });
  });

  it("shows the retry, and says nothing extra once a frame is on screen", () => {
    expect(streamBanner({ ...base, connection: "reconnecting" })?.tone).toBe("warning");
    expect(streamBanner({ ...base, connection: "connecting", hasFrame: false })?.text).toBe(
      "Connecting to this screen…",
    );
    expect(streamBanner({ ...base, connection: "connecting" })).toBeNull();
  });
});
