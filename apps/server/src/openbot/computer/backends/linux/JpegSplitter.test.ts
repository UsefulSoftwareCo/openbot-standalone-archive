import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_JPEG_SPLIT_STATE,
  readJpegSize,
  splitJpegChunk,
  type JpegSplitState,
} from "./JpegSplitter.ts";

/** A structurally valid JPEG: SOI, a SOF0 frame header carrying the
    dimensions, a comment segment padded out, then EOI. */
function jpeg(width: number, height: number, padding = 4): Uint8Array {
  const header = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  const bytes = new Uint8Array(header.length + 4 + padding + 2);
  bytes.set(header, 0);
  bytes[header.length] = 0xff;
  bytes[header.length + 1] = 0xfe;
  bytes[header.length + 2] = ((padding + 2) >> 8) & 0xff;
  bytes[header.length + 3] = (padding + 2) & 0xff;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

/** Feeds a byte stream chunk by chunk, exactly as ffmpeg's stdout arrives. */
function feed(chunks: ReadonlyArray<Uint8Array>): {
  readonly frames: ReadonlyArray<Uint8Array>;
  readonly state: JpegSplitState;
} {
  let state = EMPTY_JPEG_SPLIT_STATE;
  const frames: Array<Uint8Array> = [];
  for (const chunk of chunks) {
    const result = splitJpegChunk(state, chunk);
    state = result.state;
    frames.push(...result.frames);
  }
  return { frames, state };
}

describe("splitJpegChunk", () => {
  it("emits one frame per complete image", () => {
    const first = jpeg(320, 200);
    const { frames } = feed([first]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(first);
  });

  it("emits several frames arriving in one chunk", () => {
    const first = jpeg(320, 200);
    const second = jpeg(321, 201);
    const third = jpeg(322, 202);
    const { frames, state } = feed([concat(first, second, third)]);
    expect(frames.map((frame) => readJpegSize(frame))).toEqual([
      { width: 320, height: 200 },
      { width: 321, height: 201 },
      { width: 322, height: 202 },
    ]);
    expect(state.buffer).toHaveLength(0);
  });

  it("assembles a frame whose end-of-image straddles a chunk boundary", () => {
    const frame = jpeg(640, 480);
    // Split exactly between the FF and the D9 of the end-of-image marker.
    const head = frame.slice(0, frame.length - 1);
    const tail = frame.slice(frame.length - 1);
    const { frames } = feed([head, tail]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });

  it("assembles a frame delivered one byte at a time", () => {
    const frame = jpeg(64, 48);
    const { frames } = feed([...frame].map((byte) => new Uint8Array([byte])));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });

  it("keeps a partial trailing frame buffered until the rest arrives", () => {
    const first = jpeg(320, 200);
    const second = jpeg(320, 200, 6);
    const partial = second.slice(0, 10);
    const rest = second.slice(10);
    const step = splitJpegChunk(EMPTY_JPEG_SPLIT_STATE, concat(first, partial));
    expect(step.frames).toHaveLength(1);
    expect(step.state.buffer).toHaveLength(partial.length);
    const finish = splitJpegChunk(step.state, rest);
    expect(finish.frames).toHaveLength(1);
    expect(finish.frames[0]).toEqual(second);
  });

  it("drops bytes before the first start-of-image instead of prepending them", () => {
    const noise = new Uint8Array([0x41, 0x42, 0x0a]);
    const frame = jpeg(100, 100);
    const { frames } = feed([concat(noise, frame)]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });

  it("drops a segment that ends without ever starting an image", () => {
    const orphanEnd = new Uint8Array([0x41, 0xff, 0xd9]);
    const frame = jpeg(100, 100);
    const { frames } = feed([orphanEnd, frame]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });

  it("ignores an empty chunk", () => {
    const result = splitJpegChunk(EMPTY_JPEG_SPLIT_STATE, new Uint8Array(0));
    expect(result.frames).toEqual([]);
    expect(result.state).toBe(EMPTY_JPEG_SPLIT_STATE);
  });
});

describe("readJpegSize", () => {
  it("reads the dimensions out of the frame header", () => {
    expect(readJpegSize(jpeg(1600, 1000))).toEqual({ width: 1600, height: 1000 });
  });

  it("returns null for bytes that are not a JPEG", () => {
    expect(readJpegSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(readJpegSize(new Uint8Array(0))).toBeNull();
  });
});
