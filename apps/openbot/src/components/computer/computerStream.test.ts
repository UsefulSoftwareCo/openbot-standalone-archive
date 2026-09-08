import { describe, expect, it } from "@effect/vitest";
import {
  OpenbotComputerDisplayId,
  type OpenbotComputerDisplay,
  type OpenbotComputerStreamServerMessage,
} from "@t3tools/contracts";

import {
  ComputerStreamClient,
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

/**
 * A socket the test drives directly. The client only ever adds listeners,
 * reads `readyState`, sends and closes, so this is the whole surface it uses.
 */
class FakeSocket extends EventTarget {
  binaryType = "blob";
  readyState = 1;
  closed = false;
  readonly sent: Array<string> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  deliver(data: unknown): void {
    const event = new Event("message") as Event & { data: unknown };
    event.data = data;
    this.dispatchEvent(event);
  }
}

/** A bitmap that only remembers whether the client let go of it. */
function fakeBitmap(): { readonly bitmap: ImageBitmap; readonly isClosed: () => boolean } {
  let closed = false;
  const bitmap = {
    close: () => {
      closed = true;
    },
  } as unknown as ImageBitmap;
  return { bitmap, isClosed: () => closed };
}

/** Lets every queued `then`/`finally` on the decode chain run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const secondDisplay: OpenbotComputerDisplay = {
  ...display,
  id: OpenbotComputerDisplayId.make("2"),
  name: "Agent desktop",
  main: false,
  managed: true,
};

const PROFILE = { maxWidthPx: 1920, fps: 12 } as const;

describe("ComputerStreamClient", () => {
  it("drops a frame decoded for the display the viewer has already left", async () => {
    const sockets: Array<FakeSocket> = [];
    const painted: Array<ImageBitmap> = [];
    const decodes: Array<(bitmap: ImageBitmap) => void> = [];
    const client = new ComputerStreamClient(
      { onFrame: (bitmap) => painted.push(bitmap), onState: () => {} },
      {
        url: "ws://host/ws/openbot-computer",
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        decodeFrame: () => new Promise<ImageBitmap>((resolve) => decodes.push(resolve)),
      },
    );

    client.open(display.id, PROFILE, false);
    const first = sockets[0];
    if (first === undefined) throw new Error("the client opened no socket");
    first.dispatchEvent(new Event("open"));
    first.deliver(JSON.stringify(hello));
    first.deliver(new ArrayBuffer(8));
    expect(decodes).toHaveLength(1);

    // The user picks another display while that frame is still decoding.
    client.open(secondDisplay.id, PROFILE, false);
    const stale = fakeBitmap();
    decodes[0]?.(stale.bitmap);
    await flush();
    expect(stale.isClosed()).toBe(true);
    expect(painted).toEqual([]);

    // The new socket's frames are not trusted until it says which display it
    // is capturing, so anything in flight from before that is dropped.
    const second = sockets[1];
    if (second === undefined) throw new Error("the switch opened no second socket");
    second.dispatchEvent(new Event("open"));
    second.deliver(new ArrayBuffer(8));
    expect(decodes).toHaveLength(1);

    second.deliver(JSON.stringify({ ...hello, display: secondDisplay }));
    second.deliver(new ArrayBuffer(8));
    expect(decodes).toHaveLength(2);
    const fresh = fakeBitmap();
    decodes[1]?.(fresh.bitmap);
    await flush();
    expect(painted).toEqual([fresh.bitmap]);
    expect(fresh.isClosed()).toBe(false);

    client.close();
  });

  it("closes a frame that finishes decoding after the viewer is gone", async () => {
    const sockets: Array<FakeSocket> = [];
    const painted: Array<ImageBitmap> = [];
    const decodes: Array<(bitmap: ImageBitmap) => void> = [];
    const client = new ComputerStreamClient(
      { onFrame: (bitmap) => painted.push(bitmap), onState: () => {} },
      {
        url: "ws://host/ws/openbot-computer",
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        decodeFrame: () => new Promise<ImageBitmap>((resolve) => decodes.push(resolve)),
      },
    );
    client.open(display.id, PROFILE, false);
    const socket = sockets[0];
    if (socket === undefined) throw new Error("the client opened no socket");
    socket.dispatchEvent(new Event("open"));
    socket.deliver(JSON.stringify(hello));
    socket.deliver(new ArrayBuffer(8));

    client.close();
    const orphan = fakeBitmap();
    decodes[0]?.(orphan.bitmap);
    await flush();
    expect(orphan.isClosed()).toBe(true);
    expect(painted).toEqual([]);
    expect(socket.closed).toBe(true);
  });

  it("splits an oversized batch rather than sending one the host must reject", () => {
    const sockets: Array<FakeSocket> = [];
    const client = new ComputerStreamClient(
      { onFrame: () => {}, onState: () => {} },
      {
        url: "ws://host/ws/openbot-computer",
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      },
    );
    client.open(display.id, PROFILE, false);
    const socket = sockets[0];
    if (socket === undefined) throw new Error("the client opened no socket");
    socket.dispatchEvent(new Event("open"));
    socket.sent.length = 0;

    client.input(Array.from({ length: 70 }, () => ({ type: "text", text: "x" }) as const));
    const batches = socket.sent.map((raw) => JSON.parse(raw) as { events: ReadonlyArray<unknown> });
    expect(batches.map((batch) => batch.events.length)).toEqual([64, 6]);

    client.input([]);
    expect(socket.sent).toHaveLength(2);

    client.close();
  });
});
