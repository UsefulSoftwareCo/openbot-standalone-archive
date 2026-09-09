import { OpenbotComputerDisplayId, OpenbotComputerWindowId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPUTER_HELPER_PROTOCOL_VERSION,
  ComputerHelperProtocolError,
  MAX_HELPER_LINE_BYTES,
  MAX_HELPER_PAYLOAD_BYTES,
  decodeHelperReadyRecord,
  decodeHelperRecord,
  emptyRecordDecoderState,
  encodeHelperCommand,
  feedRecordDecoder,
} from "./ComputerHelperProtocol.ts";
import type {
  HelperCommand,
  HelperFrameEnvelope,
  RecordDecoderState,
} from "./ComputerHelperProtocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function expectSuccess<A>(result: Result.Result<A, ComputerHelperProtocolError>): A {
  if (!Result.isSuccess(result)) {
    throw new Error(`expected success, got: ${result.failure.message}`);
  }
  return result.success;
}

function expectFailure<A>(
  result: Result.Result<A, ComputerHelperProtocolError>,
): ComputerHelperProtocolError {
  if (Result.isSuccess(result)) {
    throw new Error(`expected failure, got: ${JSON.stringify(result.success)}`);
  }
  return result.failure;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

function line(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function feedAll(chunks: ReadonlyArray<Uint8Array>): ReadonlyArray<HelperFrameEnvelope> {
  let state: RecordDecoderState = emptyRecordDecoderState;
  const records: Array<HelperFrameEnvelope> = [];
  for (const chunk of chunks) {
    const fed = expectSuccess(feedRecordDecoder(state, chunk));
    state = fed.state;
    records.push(...fed.records);
  }
  return records;
}

// ---------------------------------------------------------------------------
// One canonical stream, exercised at every possible split
// ---------------------------------------------------------------------------

// A window title with combining accents and astral-plane emoji, so a naive
// decoder that decodes partial chunks produces replacement characters.
const EMOJI_TITLE = "Café ☕ — Añejo 🚀 build";

// Raw payload bytes that impersonate framing: newlines, a brace, an entire
// well-formed record, and bytes that are not valid UTF-8 at all. None of it may
// be scanned.
const IMPERSONATING_PAYLOAD = concat([
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  encoder.encode('\n{"id":99,"type":"ok"}\n{\n'),
  new Uint8Array([0x00, 0x0a, 0x7b, 0x22, 0xff, 0xd9]),
]);

const FRAME_HEADER = {
  id: 4,
  type: "frame",
  displayId: "display-1",
  widthPx: 1440,
  heightPx: 900,
  capturedAtMs: 1_725_000_000_123,
  payloadBytes: IMPERSONATING_PAYLOAD.length,
};

const CANONICAL_STREAM = concat([
  line({ type: "auth-ok", protocolVersion: COMPUTER_HELPER_PROTOCOL_VERSION }),
  line({
    id: 1,
    type: "hello",
    protocolVersion: COMPUTER_HELPER_PROTOCOL_VERSION,
    pid: 4242,
    bundleId: "codes.t3.ComputerHelper",
    permissions: { screenCapture: "granted", accessibility: "denied" },
    displays: [
      {
        id: "display-1",
        name: "Built-in Retina Display",
        kind: "physical",
        widthPx: 2880,
        heightPx: 1800,
        scale: 2,
        main: true,
        managed: false,
      },
    ],
  }),
  // A blank line between records, which the decoder must ignore.
  encoder.encode("\n"),
  line({
    id: 2,
    type: "windows",
    windows: [
      {
        id: "window-7",
        displayId: "display-1",
        title: EMOJI_TITLE,
        app: "Safari",
        pid: 991,
        x: 12,
        y: 34,
        width: 800,
        height: 600,
        focused: true,
        minimized: false,
      },
    ],
  }),
  line({
    id: 3,
    type: "input-result",
    delivered: 2,
    rejected: [{ index: 1, reason: "off-screen" }],
  }),
  line(FRAME_HEADER),
  IMPERSONATING_PAYLOAD,
  line({ type: "event", event: "displays-changed" }),
  // An unsolicited capture frame with no payload at all.
  line({
    type: "frame",
    displayId: "display-1",
    widthPx: 1440,
    heightPx: 900,
    capturedAtMs: 1_725_000_000_456,
    payloadBytes: 0,
  }),
  line({ id: 5, type: "error", code: "permission_denied", message: "Screen Recording is off" }),
]);

const EXPECTED_RECORDS: ReadonlyArray<HelperFrameEnvelope> = [
  { record: { type: "auth-ok", protocolVersion: 1 }, payload: null },
  {
    record: {
      id: 1,
      type: "hello",
      protocolVersion: 1,
      pid: 4242,
      bundleId: "codes.t3.ComputerHelper",
      permissions: { screenCapture: "granted", accessibility: "denied" },
      displays: [
        {
          id: OpenbotComputerDisplayId.make("display-1"),
          name: "Built-in Retina Display",
          kind: "physical",
          widthPx: 2880,
          heightPx: 1800,
          scale: 2,
          main: true,
          managed: false,
        },
      ],
    },
    payload: null,
  },
  {
    record: {
      id: 2,
      type: "windows",
      windows: [
        {
          id: OpenbotComputerWindowId.make("window-7"),
          displayId: OpenbotComputerDisplayId.make("display-1"),
          title: EMOJI_TITLE,
          app: "Safari",
          pid: 991,
          x: 12,
          y: 34,
          width: 800,
          height: 600,
          focused: true,
          minimized: false,
        },
      ],
    },
    payload: null,
  },
  {
    record: {
      id: 3,
      type: "input-result",
      delivered: 2,
      rejected: [{ index: 1, reason: "off-screen" }],
    },
    payload: null,
  },
  {
    record: {
      id: 4,
      type: "frame",
      displayId: OpenbotComputerDisplayId.make("display-1"),
      widthPx: 1440,
      heightPx: 900,
      capturedAtMs: 1_725_000_000_123,
      payloadBytes: IMPERSONATING_PAYLOAD.length,
    },
    payload: IMPERSONATING_PAYLOAD,
  },
  { record: { type: "event", event: "displays-changed" }, payload: null },
  {
    record: {
      type: "frame",
      displayId: OpenbotComputerDisplayId.make("display-1"),
      widthPx: 1440,
      heightPx: 900,
      capturedAtMs: 1_725_000_000_456,
      payloadBytes: 0,
    },
    payload: new Uint8Array(0),
  },
  {
    record: { id: 5, type: "error", code: "permission_denied", message: "Screen Recording is off" },
    payload: null,
  },
];

describe("feedRecordDecoder framing", () => {
  it("decodes the whole stream from a single chunk", () => {
    expect(feedAll([CANONICAL_STREAM])).toEqual(EXPECTED_RECORDS);
  });

  it("decodes the same records at every single split point", () => {
    for (let split = 0; split <= CANONICAL_STREAM.length; split += 1) {
      const records = feedAll([
        CANONICAL_STREAM.subarray(0, split),
        CANONICAL_STREAM.subarray(split),
      ]);
      expect(records, `split at byte ${split}`).toEqual(EXPECTED_RECORDS);
    }
  });

  it("decodes the same records one byte at a time", () => {
    const chunks: Array<Uint8Array> = [];
    for (let at = 0; at < CANONICAL_STREAM.length; at += 1) {
      chunks.push(CANONICAL_STREAM.subarray(at, at + 1));
    }
    expect(feedAll(chunks)).toEqual(EXPECTED_RECORDS);
  });

  it("emits nothing and stays empty for an empty chunk", () => {
    const fed = expectSuccess(feedRecordDecoder(emptyRecordDecoderState, new Uint8Array(0)));
    expect(fed.records).toEqual([]);
    expect(fed.state.buffer.length).toBe(0);
    expect(fed.state.pending).toBeNull();
  });

  it("leaves a partial line buffered without emitting it", () => {
    const fed = expectSuccess(
      feedRecordDecoder(emptyRecordDecoderState, encoder.encode('{"id":1,"type":"ok"')),
    );
    expect(fed.records).toEqual([]);
    const finished = expectSuccess(feedRecordDecoder(fed.state, encoder.encode("}\n")));
    expect(finished.records).toEqual([{ record: { id: 1, type: "ok" }, payload: null }]);
  });

  it("yields an empty payload rather than null for payloadBytes 0", () => {
    const [envelope] = feedAll([
      line({
        type: "frame",
        displayId: "display-1",
        widthPx: 10,
        heightPx: 10,
        capturedAtMs: 1,
        payloadBytes: 0,
      }),
    ]);
    expect(envelope?.payload).toEqual(new Uint8Array(0));
    expect(envelope?.payload).not.toBeNull();
  });

  it("ignores blank and whitespace-only lines", () => {
    expect(
      feedAll([encoder.encode("\n  \n\r\n"), line({ id: 1, type: "ok" }), encoder.encode("\n")]),
    ).toEqual([{ record: { id: 1, type: "ok" }, payload: null }]);
  });

  it("does not treat a caller's chunk boundary inside a multi-byte character as a record", () => {
    const stream = line({
      id: 2,
      type: "windows",
      windows: [
        {
          id: "window-7",
          displayId: null,
          title: EMOJI_TITLE,
          app: "Safari",
          pid: null,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          focused: false,
          minimized: true,
        },
      ],
    });
    const emojiStart = stream.findIndex((byte) => byte > 0x7f);
    expect(emojiStart).toBeGreaterThan(0);
    // Split in the middle of the first multi-byte sequence.
    const [envelope] = feedAll([
      stream.subarray(0, emojiStart + 1),
      stream.subarray(emojiStart + 1),
    ]);
    expect(envelope?.record).toMatchObject({ type: "windows" });
    const record = envelope?.record;
    expect(record?.type === "windows" ? record.windows[0]?.title : null).toBe(EMOJI_TITLE);
  });

  it("rejects a line longer than the limit before it completes", () => {
    const oversized = new Uint8Array(MAX_HELPER_LINE_BYTES + 1).fill(0x61);
    const error = expectFailure(feedRecordDecoder(emptyRecordDecoderState, oversized));
    expect(error).toBeInstanceOf(ComputerHelperProtocolError);
    expect(error.reason).toContain("no longer framed");
  });

  it("keeps buffering a line that is still within the limit", () => {
    const withinLimit = new Uint8Array(MAX_HELPER_LINE_BYTES).fill(0x61);
    const fed = expectSuccess(feedRecordDecoder(emptyRecordDecoderState, withinLimit));
    expect(fed.records).toEqual([]);
    expect(fed.state.buffer.length).toBe(MAX_HELPER_LINE_BYTES);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["absurd", MAX_HELPER_PAYLOAD_BYTES + 1],
  ])("rejects a %s payloadBytes", (_label, payloadBytes) => {
    const error = expectFailure(
      feedRecordDecoder(
        emptyRecordDecoderState,
        line({
          id: 1,
          type: "frame",
          displayId: "display-1",
          widthPx: 10,
          heightPx: 10,
          capturedAtMs: 1,
          payloadBytes,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ComputerHelperProtocolError);
  });

  it("rejects an unknown record type", () => {
    const error = expectFailure(
      feedRecordDecoder(emptyRecordDecoderState, line({ id: 1, type: "teleport" })),
    );
    expect(error.reason).toContain("unreadable record");
  });

  it("rejects malformed JSON", () => {
    const error = expectFailure(
      feedRecordDecoder(emptyRecordDecoderState, encoder.encode('{"id":1,"type":\n')),
    );
    expect(error.reason).toContain("unreadable record");
  });

  it("tolerates fields a newer helper adds", () => {
    const records = feedAll([line({ id: 1, type: "ok", somethingNewer: { nested: true } })]);
    expect(records).toEqual([{ record: { id: 1, type: "ok" }, payload: null }]);
  });
});

// ---------------------------------------------------------------------------
// Single-line codecs
// ---------------------------------------------------------------------------

describe("decodeHelperRecord", () => {
  it("accepts every error code the domain contract defines", () => {
    for (const code of [
      "unsupported",
      "capture_failed",
      "permission_denied",
      "display_not_found",
      "window_not_found",
      "not_controlling",
      "setup_required",
      "backend_unavailable",
      "invalid_input",
    ]) {
      const record = expectSuccess(
        decodeHelperRecord(JSON.stringify({ type: "error", code, message: "no" })),
      );
      expect(record).toEqual({ type: "error", code, message: "no" });
    }
  });

  it("rejects an error code the domain contract does not define", () => {
    expectFailure(
      decodeHelperRecord(JSON.stringify({ type: "error", code: "kaput", message: "no" })),
    );
  });

  it("reads how many windows a launch placed", () => {
    expect(
      expectSuccess(
        decodeHelperRecord(
          JSON.stringify({ id: 9, type: "launched", pid: 4242, placedWindows: 2, placed: true }),
        ),
      ),
    ).toEqual({ id: 9, type: "launched", pid: 4242, placedWindows: 2, placed: true });

    // The case the server has to warn about rather than celebrate.
    expect(
      expectSuccess(
        decodeHelperRecord(
          JSON.stringify({ id: 9, type: "launched", pid: 4242, placedWindows: 0, placed: false }),
        ),
      ),
    ).toEqual({ id: 9, type: "launched", pid: 4242, placedWindows: 0, placed: false });
  });

  /**
   * The installed helper bundle is only rebuilt when the user rebuilds it, so a
   * server that has learned about placement still has to talk to one that has
   * not.
   */
  it("accepts a launch reply from a helper that knows nothing about placement", () => {
    expect(
      expectSuccess(decodeHelperRecord(JSON.stringify({ id: 9, type: "launched", pid: 4242 }))),
    ).toEqual({ id: 9, type: "launched", pid: 4242 });
  });

  it("rejects a display id that names nothing", () => {
    const display = {
      id: "display-1",
      name: "Built-in",
      kind: "physical",
      widthPx: 100,
      heightPx: 100,
      scale: 1,
      main: true,
      managed: false,
    };
    expectSuccess(decodeHelperRecord(JSON.stringify({ id: 1, type: "display", display })));
    expectFailure(
      decodeHelperRecord(
        JSON.stringify({ id: 1, type: "display", display: { ...display, id: "  " } }),
      ),
    );
  });
});

describe("decodeHelperReadyRecord", () => {
  it("parses the ready line", () => {
    expect(
      expectSuccess(
        decodeHelperReadyRecord(
          JSON.stringify({
            event: "ready",
            pid: 321,
            socket: "/tmp/t3-helper.sock",
            protocolVersion: COMPUTER_HELPER_PROTOCOL_VERSION,
          }),
        ),
      ),
    ).toEqual({
      event: "ready",
      pid: 321,
      socket: "/tmp/t3-helper.sock",
      protocolVersion: 1,
    });
  });

  it("rejects a ready line that is missing the socket", () => {
    const error = expectFailure(
      decodeHelperReadyRecord(JSON.stringify({ event: "ready", pid: 1, protocolVersion: 1 })),
    );
    expect(error.reason).toContain("unreadable ready file");
  });
});

// ---------------------------------------------------------------------------
// Command encoding
// ---------------------------------------------------------------------------

const DISPLAY_ID = OpenbotComputerDisplayId.make("display-1");
const WINDOW_ID = OpenbotComputerWindowId.make("window-7");

const COMMANDS: ReadonlyArray<HelperCommand> = [
  { id: 1, type: "hello", protocolVersion: COMPUTER_HELPER_PROTOCOL_VERSION },
  { id: 2, type: "displays" },
  { id: 3, type: "windows" },
  { id: 4, type: "focus-window", windowId: WINDOW_ID },
  { id: 5, type: "screenshot", displayId: DISPLAY_ID, maxWidthPx: 1280 },
  {
    id: 6,
    type: "capture-start",
    displayId: DISPLAY_ID,
    maxWidthPx: 1280,
    fps: 10,
    quality: 0.7,
  },
  { id: 7, type: "capture-stop", displayId: DISPLAY_ID },
  {
    id: 8,
    type: "input",
    displayId: DISPLAY_ID,
    events: [
      { type: "move", point: { x: 10, y: 20 } },
      { type: "click", button: "left", count: 2, point: { x: 10, y: 20 } },
      { type: "key-press", key: "KeyA", modifiers: ["meta"] },
      { type: "text", text: "Café ☕" },
      { type: "release-all" },
    ],
  },
  { id: 9, type: "create-display", name: "Agent", widthPx: 1280, heightPx: 800, hiDpi: true },
  { id: 10, type: "create-display", name: null, widthPx: 1280, heightPx: 800, hiDpi: false },
  { id: 11, type: "destroy-display", displayId: DISPLAY_ID },
  { id: 12, type: "launch", app: "Safari", args: ["--new-window"], displayId: DISPLAY_ID },
  { id: 13, type: "launch", app: "Safari", args: [], displayId: null },
  { id: 14, type: "request-permissions" },
  { id: 15, type: "shutdown" },
  { type: "auth", token: "secret-token" },
];

describe("encodeHelperCommand", () => {
  it.each(COMMANDS.map((command) => [command.type, command] as const))(
    "round-trips a %s command through JSON",
    (_type, command) => {
      const encoded = encodeHelperCommand(command);
      const text = decoder.decode(encoded);
      expect(text.endsWith("\n")).toBe(true);
      expect(text.slice(0, -1)).not.toContain("\n");
      expect(JSON.parse(text)).toEqual(command);
    },
  );

  it("produces a line the record decoder splits on", () => {
    // Commands never carry a payload, so a run of them is pure line framing.
    const stream = concat(COMMANDS.map(encodeHelperCommand));
    let newlines = 0;
    for (const byte of stream) {
      if (byte === 0x0a) newlines += 1;
    }
    expect(newlines).toBe(COMMANDS.length);
  });
});
