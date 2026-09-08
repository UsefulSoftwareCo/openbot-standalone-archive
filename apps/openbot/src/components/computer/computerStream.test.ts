import { describe, expect, it } from "@effect/vitest";
import {
  OpenbotComputerDisplayId,
  type OpenbotComputerDisplay,
  type OpenbotComputerStreamServerMessage,
} from "@t3tools/contracts";

import {
  computerStreamUrl,
  INITIAL_STREAM_STATE,
  parseServerMessage,
  reconnectDelayMs,
  reduceStreamState,
  shouldReconnect,
  type ComputerStreamState,
} from "./computerStream";

const display: OpenbotComputerDisplay = {
  id: OpenbotComputerDisplayId.make("69732928"),
  name: "Built-in Retina Display",
  kind: "physical",
  widthPx: 3456,
  heightPx: 2234,
  scale: 2,
  main: true,
  managed: false,
};

const hello: OpenbotComputerStreamServerMessage = {
  type: "hello",
  viewerId: "viewer-1",
  display,
  frameWidthPx: 1728,
  frameHeightPx: 1117,
  fps: 12,
  encoding: "image/jpeg",
  controller: null,
  controlling: false,
};

function server(message: OpenbotComputerStreamServerMessage) {
  return { type: "server", message } as const;
}

function afterHello(): ComputerStreamState {
  return reduceStreamState(INITIAL_STREAM_STATE, server(hello));
}

describe("reduceStreamState", () => {
  it("learns the display and frame size from hello", () => {
    const state = afterHello();
    expect(state).toMatchObject({
      connection: "open",
      display,
      frameWidthPx: 1728,
      frameHeightPx: 1117,
      fps: 12,
      status: "capturing",
      controlling: false,
    });
  });

  it("follows a display mode change without dropping the socket", () => {
    const state = reduceStreamState(
      afterHello(),
      server({
        type: "geometry",
        display: { ...display, widthPx: 1920, heightPx: 1080 },
        frameWidthPx: 960,
        frameHeightPx: 540,
      }),
    );
    expect(state.frameWidthPx).toBe(960);
    expect(state.display?.widthPx).toBe(1920);
    expect(state.connection).toBe("open");
  });

  it("names who is controlling, including this viewer", () => {
    const taken = reduceStreamState(
      afterHello(),
      server({
        type: "controller",
        controller: { kind: "viewer", label: "Rhys", since: "2026-09-08T10:00:00.000Z" },
        controlling: true,
      }),
    );
    expect(taken.controlling).toBe(true);
    expect(taken.controller?.label).toBe("Rhys");

    const released = reduceStreamState(
      taken,
      server({ type: "controller", controller: null, controlling: false }),
    );
    expect(released.controller).toBeNull();
    expect(released.controlling).toBe(false);
  });

  it("keeps the last input acknowledgement, rejections and all", () => {
    const state = reduceStreamState(
      afterHello(),
      server({
        type: "input-ack",
        seq: 7,
        result: { delivered: 2, rejected: [{ index: 2, reason: "not_controlling" }] },
      }),
    );
    expect(state.lastAck).toEqual({
      seq: 7,
      result: { delivered: 2, rejected: [{ index: 2, reason: "not_controlling" }] },
    });
  });

  it("carries the server's own words for a bad state", () => {
    const state = reduceStreamState(
      afterHello(),
      server({ type: "status", state: "permission-denied", message: "Screen Recording is off." }),
    );
    expect(state.status).toBe("permission-denied");
    expect(state.message).toBe("Screen Recording is off.");
  });

  it("shows the last frame while reconnecting, but never claims control", () => {
    const controlling = reduceStreamState(
      afterHello(),
      server({ type: "controller", controller: null, controlling: true }),
    );
    const dropped = reduceStreamState(controlling, { type: "closed", willRetry: true });
    expect(dropped.connection).toBe("reconnecting");
    expect(dropped.controlling).toBe(false);
    expect(dropped.display).toEqual(display);
    expect(dropped.frameWidthPx).toBe(1728);
  });

  it("distinguishes a first connection from a retry, and a close from a drop", () => {
    expect(
      reduceStreamState(INITIAL_STREAM_STATE, { type: "connecting", retry: false }).connection,
    ).toBe("connecting");
    expect(
      reduceStreamState(INITIAL_STREAM_STATE, { type: "connecting", retry: true }).connection,
    ).toBe("reconnecting");
    expect(reduceStreamState(afterHello(), { type: "closed", willRetry: false }).connection).toBe(
      "closed",
    );
  });

  it("records a socket failure as an error worth retrying", () => {
    const state = reduceStreamState(afterHello(), { type: "failed", message: "socket died" });
    expect(state.status).toBe("error");
    expect(shouldReconnect(state)).toBe(true);
  });

  it("clears a stale error when the stream says hello again", () => {
    const recovered = reduceStreamState(
      reduceStreamState(afterHello(), { type: "failed", message: "socket died" }),
      server(hello),
    );
    expect(recovered.status).toBe("capturing");
    expect(recovered.message).toBeNull();
  });

  it("records the echoed ping", () => {
    expect(reduceStreamState(afterHello(), server({ type: "pong", t: 1234 })).lastPongT).toBe(1234);
  });
});

describe("shouldReconnect", () => {
  it("stops for answers, retries for failures", () => {
    const statuses = ["superseded", "display-gone", "permission-denied"] as const;
    for (const status of statuses) {
      expect(shouldReconnect({ ...INITIAL_STREAM_STATE, status })).toBe(false);
    }
    expect(shouldReconnect({ ...INITIAL_STREAM_STATE, status: "error" })).toBe(true);
    expect(shouldReconnect(INITIAL_STREAM_STATE)).toBe(true);
  });
});

describe("reconnectDelayMs", () => {
  it("backs off from half a second and caps at eight", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(4)).toBe(8000);
    expect(reconnectDelayMs(40)).toBe(8000);
    expect(reconnectDelayMs(-3)).toBe(500);
  });
});

describe("computerStreamUrl", () => {
  it("follows the page's own origin and scheme", () => {
    expect(computerStreamUrl({ protocol: "http:", host: "localhost:5735" })).toBe(
      "ws://localhost:5735/ws/openbot-computer",
    );
    expect(computerStreamUrl({ protocol: "https:", host: "box.tail1234.ts.net" })).toBe(
      "wss://box.tail1234.ts.net/ws/openbot-computer",
    );
  });
});

describe("parseServerMessage", () => {
  it("parses a frame the contract knows", () => {
    expect(parseServerMessage(JSON.stringify(hello))).toMatchObject({ type: "hello", fps: 12 });
  });

  it("ignores anything it cannot read instead of tearing down the socket", () => {
    expect(parseServerMessage("not json")).toBeUndefined();
    expect(parseServerMessage(JSON.stringify({ type: "from-a-newer-server" }))).toBeUndefined();
    expect(parseServerMessage(JSON.stringify({ type: "pong" }))).toBeUndefined();
  });
});
