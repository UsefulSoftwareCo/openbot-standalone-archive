/**
 * Cuts ffmpeg's raw MJPEG byte stream back into whole JPEG files.
 *
 * Safe because JPEG byte-stuffs every `FF` inside entropy-coded data as
 * `FF 00`, so an `FF D9` pair is always the real end-of-image, and ffmpeg's
 * mjpeg muxer writes no EXIF thumbnail that could contain a nested one.
 *
 * The state is a value rather than an object with methods so the splitter
 * drops straight into `Stream.mapAccumArray` and can be proven against
 * chunk boundaries without a process anywhere near it.
 */

const SOI_SECOND_BYTE = 0xd8;
const EOI_SECOND_BYTE = 0xd9;
const MARKER_FIRST_BYTE = 0xff;

export interface JpegSplitState {
  /** Bytes of the frame being assembled, including any leading garbage that
      has not yet been resolved into a start-of-image. */
  readonly buffer: Uint8Array;
  /** Index to resume scanning from. Never 0: an end-of-image is a two-byte
      pair, so the first byte that can complete one is at index 1. */
  readonly scanned: number;
}

export const EMPTY_JPEG_SPLIT_STATE: JpegSplitState = {
  buffer: new Uint8Array(0),
  scanned: 1,
};

export interface JpegSplitResult {
  readonly state: JpegSplitState;
  readonly frames: ReadonlyArray<Uint8Array>;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

/** Index of the first `FF D8` at or after `from`, or -1. */
function indexOfStartOfImage(bytes: Uint8Array, from: number): number {
  for (let index = from; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === MARKER_FIRST_BYTE && bytes[index + 1] === SOI_SECOND_BYTE) return index;
  }
  return -1;
}

/**
 * Folds one chunk of the MJPEG stream into whole frames.
 *
 * Bytes before the first start-of-image are dropped rather than prepended to
 * the first frame: ffmpeg writes a line of its own to stdout in some failure
 * modes, and a decoder handed that plus a JPEG shows nothing at all.
 */
export function splitJpegChunk(state: JpegSplitState, chunk: Uint8Array): JpegSplitResult {
  if (chunk.length === 0) return { state, frames: [] };
  const buffer = concat(state.buffer, chunk);
  const frames: Array<Uint8Array> = [];
  let start = 0;
  for (let index = Math.max(1, state.scanned); index < buffer.length; index += 1) {
    if (buffer[index - 1] !== MARKER_FIRST_BYTE || buffer[index] !== EOI_SECOND_BYTE) continue;
    const candidateStart = indexOfStartOfImage(buffer, start);
    if (candidateStart >= 0 && candidateStart < index) {
      frames.push(buffer.slice(candidateStart, index + 1));
    }
    start = index + 1;
    // An end-of-image marker's second byte cannot also start the next marker.
    index += 1;
  }
  const remaining = start === 0 ? buffer : buffer.slice(start);
  return {
    state: { buffer: remaining, scanned: Math.max(1, remaining.length) },
    frames,
  };
}

/**
 * Width and height from a JPEG's frame header, so a caller reports the size it
 * actually encoded rather than the size it asked for. Null when the bytes are
 * not a JPEG this walker understands.
 */
export function readJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== MARKER_FIRST_BYTE || bytes[1] !== SOI_SECOND_BYTE) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== MARKER_FIRST_BYTE) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers carry no length payload.
    if (marker === SOI_SECOND_BYTE || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    // SOF0..SOF15, minus the three markers that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
