import {
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  OpenbotComputerInputEvent,
  OpenbotComputerWindowId,
} from "@t3tools/contracts";
import type { OpenbotComputerPermissionState } from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The wire the macOS helper app speaks, and the framing that carries it.
 *
 * This is a boundary DTO layer, not the domain contract. `packages/contracts`
 * describes what a client is promised; this file describes what one particular
 * subprocess actually writes to a pipe or socket, and the two are free to
 * diverge. Everything arriving from the helper is parsed with Schema, so no
 * value reaches the backend without having been proven to have its shape.
 *
 * Framing: one JSON object per `\n`-terminated UTF-8 line. A record carrying a
 * `payloadBytes` field is followed by exactly that many raw bytes, starting
 * immediately after the newline; the next JSON line begins after them. Payload
 * bytes are opaque, so the decoder counts them rather than scanning them, which
 * is the only reason a JPEG containing `\n` or `{` cannot desynchronize the
 * stream.
 */

/** The wire revision this server implements. Sent in `hello`, echoed by the
    helper, and compared by the client so a stale helper fails loudly. */
export const COMPUTER_HELPER_PROTOCOL_VERSION = 1;

/** Longest JSON line the decoder will buffer before declaring the stream
    desynchronized. A line this long is never legitimate; it means payload bytes
    were mistaken for line bytes. */
export const MAX_HELPER_LINE_BYTES = 1024 * 1024;

/** Largest payload a single record may declare. Bounds the allocation a
    malformed or hostile `payloadBytes` can force. */
export const MAX_HELPER_PAYLOAD_BYTES = 64 * 1024 * 1024;

const LINE_FEED = 0x0a;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** The helper only ever reports a gate it can actually ask about, so it has no
    `not-applicable`; the backend widens to the domain state. */
const HelperPermissionState = Schema.Literals(["granted", "denied", "unknown"]);
type HelperPermissionState = typeof HelperPermissionState.Type;

// Compile-time proof that the narrower wire states read as domain states, so
// the backend can widen without a cast.
type _HelperPermissionStateIsDomainState =
  HelperPermissionState extends OpenbotComputerPermissionState ? true : never;

/** macOS reports screen capture and input injection as separate grants. The
    wire carries only the two states; the human-readable `detail` the domain
    contract adds is composed by the backend. */
export const HelperPermissions = Schema.Struct({
  screenCapture: HelperPermissionState,
  accessibility: HelperPermissionState,
});
export type HelperPermissions = typeof HelperPermissions.Type;

/** One screen the helper can capture. `managed-virtual` displays are the ones
    this server asked the helper to create. */
export const HelperDisplay = Schema.Struct({
  id: OpenbotComputerDisplayId,
  name: Schema.String,
  kind: Schema.Literals(["physical", "managed-virtual"]),
  widthPx: Schema.Int,
  heightPx: Schema.Int,
  scale: Schema.Number,
  main: Schema.Boolean,
  managed: Schema.Boolean,
});
export type HelperDisplay = typeof HelperDisplay.Type;

/** One window on the shared login session, framed in the pixel space of
    `displayId`. */
export const HelperWindow = Schema.Struct({
  id: OpenbotComputerWindowId,
  displayId: Schema.NullOr(OpenbotComputerDisplayId),
  title: Schema.String,
  app: Schema.String,
  pid: Schema.NullOr(Schema.Int),
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  focused: Schema.Boolean,
  minimized: Schema.Boolean,
});
export type HelperWindow = typeof HelperWindow.Type;

/** The helper reports failures with the same codes the domain error uses, so
    the backend forwards a code instead of inventing a mapping. Reused rather
    than restated: a new domain code is then a compile error here, not a silent
    `unknown`. */
const HelperErrorCode = OpenbotComputerError.fields.code;

// ---------------------------------------------------------------------------
// Records (helper -> server)
// ---------------------------------------------------------------------------

/**
 * `protocolVersion` is a plain integer on the way in, deliberately: a helper
 * built against another revision must surface as a version mismatch the client
 * can explain, not as an unparseable record.
 */
const HelperAuthOkRecord = Schema.Struct({
  type: Schema.Literal("auth-ok"),
  protocolVersion: Schema.Int,
});

const HelperHelloRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("hello"),
  protocolVersion: Schema.Int,
  pid: Schema.Int,
  bundleId: Schema.NullOr(Schema.String),
  permissions: HelperPermissions,
  displays: Schema.Array(HelperDisplay),
});

const HelperDisplaysRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("displays"),
  displays: Schema.Array(HelperDisplay),
});

const HelperWindowsRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("windows"),
  windows: Schema.Array(HelperWindow),
});

const HelperOkRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("ok"),
});

const HelperDisplayRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("display"),
  display: HelperDisplay,
});

/**
 * The placement fields are optional in both directions. The helper omits them
 * when the launch named no display and so asked for no placement, and a helper
 * built before they existed omits them always — which must decode rather than
 * fail, since the user's installed bundle is only rebuilt when they rebuild it.
 */
const HelperLaunchedRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("launched"),
  pid: Schema.NullOr(Schema.Int),
  placedWindows: Schema.optional(Schema.Int),
  placed: Schema.optional(Schema.Boolean),
});

const HelperPermissionsRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("permissions"),
  permissions: HelperPermissions,
});

const HelperInputResultRecord = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("input-result"),
  delivered: Schema.Int,
  rejected: Schema.Array(
    Schema.Struct({
      index: Schema.Int,
      reason: Schema.String,
    }),
  ),
});

/**
 * One encoded image. `id` present means this is the reply to a `screenshot`;
 * `id` absent means it is an unsolicited frame from a running capture, which is
 * how one command can be answered by an unbounded number of records.
 *
 * `payloadBytes` is bounded here rather than in the framing loop so that an
 * absurd length is rejected by the same parser that rejects every other bad
 * field.
 */
const HelperFrameRecord = Schema.Struct({
  id: Schema.optional(Schema.Int),
  type: Schema.Literal("frame"),
  displayId: OpenbotComputerDisplayId,
  widthPx: Schema.Int,
  heightPx: Schema.Int,
  capturedAtMs: Schema.Number,
  payloadBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_HELPER_PAYLOAD_BYTES }),
  ),
});

const HelperEventRecord = Schema.Struct({
  type: Schema.Literal("event"),
  event: Schema.Literals(["displays-changed", "permissions-changed"]),
});

const HelperErrorRecord = Schema.Struct({
  id: Schema.optional(Schema.Int),
  type: Schema.Literal("error"),
  code: HelperErrorCode,
  message: Schema.String,
});

/** Everything the helper can write, discriminated on `type`. */
export const HelperRecord = Schema.Union([
  HelperAuthOkRecord,
  HelperHelloRecord,
  HelperDisplaysRecord,
  HelperWindowsRecord,
  HelperOkRecord,
  HelperDisplayRecord,
  HelperLaunchedRecord,
  HelperPermissionsRecord,
  HelperInputResultRecord,
  HelperFrameRecord,
  HelperEventRecord,
  HelperErrorRecord,
]);
export type HelperRecord = typeof HelperRecord.Type;

/**
 * The line the helper writes to its ready file when launched in socket mode.
 * It is how the server learns which socket to connect to without racing the
 * helper's own startup.
 */
export const HelperReadyRecord = Schema.Struct({
  event: Schema.Literal("ready"),
  pid: Schema.Int,
  socket: Schema.String,
  protocolVersion: Schema.Int,
});
export type HelperReadyRecord = typeof HelperReadyRecord.Type;

// ---------------------------------------------------------------------------
// Commands (server -> helper)
// ---------------------------------------------------------------------------

/**
 * Commands pin `protocolVersion` to the literal this server implements. Unlike
 * the record side there is nothing to negotiate: we can only speak the revision
 * we were compiled against, so sending any other value is a bug the type system
 * should refuse.
 */
const HelperHelloCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("hello"),
  protocolVersion: Schema.Literal(COMPUTER_HELPER_PROTOCOL_VERSION),
});

const HelperDisplaysCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("displays"),
});

const HelperWindowsCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("windows"),
});

const HelperFocusWindowCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("focus-window"),
  windowId: OpenbotComputerWindowId,
});

const HelperScreenshotCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("screenshot"),
  displayId: OpenbotComputerDisplayId,
  maxWidthPx: Schema.Int,
});

const HelperCaptureStartCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("capture-start"),
  displayId: OpenbotComputerDisplayId,
  maxWidthPx: Schema.Int,
  fps: Schema.Int,
  quality: Schema.Number,
});

const HelperCaptureStopCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("capture-stop"),
  displayId: OpenbotComputerDisplayId,
});

const HelperInputCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("input"),
  displayId: OpenbotComputerDisplayId,
  events: Schema.Array(OpenbotComputerInputEvent),
});

const HelperCreateDisplayCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("create-display"),
  name: Schema.NullOr(Schema.String),
  widthPx: Schema.Int,
  heightPx: Schema.Int,
  hiDpi: Schema.Boolean,
});

const HelperDestroyDisplayCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("destroy-display"),
  displayId: OpenbotComputerDisplayId,
});

const HelperLaunchCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("launch"),
  app: Schema.String,
  args: Schema.Array(Schema.String),
  displayId: Schema.NullOr(OpenbotComputerDisplayId),
});

const HelperRequestPermissionsCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("request-permissions"),
});

const HelperShutdownCommand = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literal("shutdown"),
});

/** Socket transport only, and only ever as the first line. It carries no `id`
    because the helper answers it with `auth-ok` before any request numbering
    exists. */
const HelperAuthCommand = Schema.Struct({
  type: Schema.Literal("auth"),
  token: Schema.String,
});

/** Everything the server can write, discriminated on `type`. No command ever
    carries a payload. */
export const HelperCommand = Schema.Union([
  HelperHelloCommand,
  HelperDisplaysCommand,
  HelperWindowsCommand,
  HelperFocusWindowCommand,
  HelperScreenshotCommand,
  HelperCaptureStartCommand,
  HelperCaptureStopCommand,
  HelperInputCommand,
  HelperCreateDisplayCommand,
  HelperDestroyDisplayCommand,
  HelperLaunchCommand,
  HelperRequestPermissionsCommand,
  HelperShutdownCommand,
  HelperAuthCommand,
]);
export type HelperCommand = typeof HelperCommand.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The stream said something this protocol does not define: an unknown record, a
 * bad field, a `payloadBytes` that cannot be honored, or framing that has lost
 * its place. Every one of these is unrecoverable for the connection carrying
 * it, because after a framing mistake the decoder no longer knows where the
 * next record begins.
 *
 * `reason` is a bounded, value-free description safe to log and show.
 */
export class ComputerHelperProtocolError extends Schema.TaggedErrorClass<ComputerHelperProtocolError>()(
  "ComputerHelperProtocolError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `The macOS computer helper sent something this server cannot read: ${this.reason}`;
  }
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

const encodeCommandJson = Schema.encodeSync(Schema.fromJsonString(HelperCommand));
const decodeRecordJson = decodeJsonResult(HelperRecord);
const decodeReadyJson = decodeJsonResult(HelperReadyRecord);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Serializes one command to the `\n`-terminated UTF-8 line the helper reads.
 *
 * @throws A `SchemaError` if the command cannot be encoded. Every `HelperCommand`
 * is encodable by construction, so a throw here is a defect in this module, not
 * a wire failure.
 */
export const encodeHelperCommand = (command: HelperCommand): Uint8Array =>
  textEncoder.encode(`${encodeCommandJson(command)}\n`);

/**
 * Parses one already-framed JSON line into a record. Callers that read from a
 * byte stream want `feedRecordDecoder` instead; this is the seam for a
 * transport that already delivers whole lines.
 */
export const decodeHelperRecord = (
  line: string,
): Result.Result<HelperRecord, ComputerHelperProtocolError> => {
  const decoded = decodeRecordJson(line);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(
        new ComputerHelperProtocolError({
          reason: `unreadable record: ${formatSchemaError(decoded.failure)}`,
        }),
      );
};

/** Parses the single line the helper writes to its ready file. */
export const decodeHelperReadyRecord = (
  line: string,
): Result.Result<HelperReadyRecord, ComputerHelperProtocolError> => {
  const decoded = decodeReadyJson(line);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(
        new ComputerHelperProtocolError({
          reason: `unreadable ready file: ${formatSchemaError(decoded.failure)}`,
        }),
      );
};

// ---------------------------------------------------------------------------
// Incremental framing
// ---------------------------------------------------------------------------

/** One record plus its payload, if the record declared one. */
export interface HelperFrameEnvelope {
  readonly record: HelperRecord;
  readonly payload: Uint8Array | null;
}

/** A record whose line has been read but whose payload has not all arrived.
 *
 * The buffer is allocated once, at its declared length, and filled in place as
 * chunks arrive. Accumulating slices instead would copy the payload again for
 * every chunk it spans, which on a multi-megabyte JPEG at 12fps is the
 * difference between one copy and dozens. The length is safe to trust up front
 * because the record schema has already bounded it. */
interface PendingPayload {
  readonly record: HelperRecord;
  readonly payload: Uint8Array;
  readonly filled: number;
}

/**
 * Opaque immutable state of the incremental framing decoder.
 *
 * `pending` is what makes payloads safe: while it is set the decoder counts
 * bytes and never looks for a newline, so payload content cannot be mistaken
 * for framing. `buffer` is only ever a partial JSON line, which is why it can
 * be bounded.
 *
 * A state is threaded forward, never replayed: the payload buffer inside
 * `pending` is filled in place, so feeding two chunks to the same state
 * decodes garbage rather than two alternative futures.
 */
export interface RecordDecoderState {
  readonly buffer: Uint8Array;
  readonly pending: PendingPayload | null;
}

/** A decoder that has seen nothing yet. */
export const emptyRecordDecoderState: RecordDecoderState = {
  buffer: new Uint8Array(0),
  pending: null,
};

function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

/**
 * Feeds one transport chunk to the decoder.
 *
 * Returns the records completed by this chunk, in order, and the state to feed
 * the next one. A chunk may complete none, one, or many records and may split
 * anywhere: mid-line, at the newline, between a line and its payload, or
 * mid-payload.
 *
 * Fails only on framing this protocol cannot represent — an over-long line with
 * no newline, or a record that does not parse. Both are terminal for the
 * connection: once framing is lost there is no defined place to resume.
 *
 * Ownership of `chunk` passes to the decoder. It is retained by reference until
 * the records inside it are complete, so a caller that recycles its read buffer
 * must pass a copy.
 */
export const feedRecordDecoder = (
  state: RecordDecoderState,
  chunk: Uint8Array,
): Result.Result<
  { readonly state: RecordDecoderState; readonly records: ReadonlyArray<HelperFrameEnvelope> },
  ComputerHelperProtocolError
> => {
  const records: Array<HelperFrameEnvelope> = [];
  const buffer = state.buffer.length === 0 ? chunk : joinBytes(state.buffer, chunk);
  let pending = state.pending;
  let offset = 0;

  for (;;) {
    if (pending !== null) {
      const needed = pending.payload.length - pending.filled;
      const available = buffer.length - offset;
      const take = needed < available ? needed : available;
      if (take > 0) {
        pending.payload.set(buffer.subarray(offset, offset + take), pending.filled);
        offset += take;
      }
      const filled = pending.filled + take;
      if (filled < pending.payload.length) {
        pending = { record: pending.record, payload: pending.payload, filled };
        break;
      }
      records.push({ record: pending.record, payload: pending.payload });
      pending = null;
      continue;
    }

    const newline = buffer.indexOf(LINE_FEED, offset);
    if (newline < 0) {
      if (buffer.length - offset > MAX_HELPER_LINE_BYTES) {
        return Result.fail(
          new ComputerHelperProtocolError({
            reason: `a record line exceeded ${MAX_HELPER_LINE_BYTES} bytes without a newline, so the stream is no longer framed`,
          }),
        );
      }
      break;
    }

    const lineBytes = buffer.subarray(offset, newline);
    offset = newline + 1;
    if (lineBytes.length > MAX_HELPER_LINE_BYTES) {
      return Result.fail(
        new ComputerHelperProtocolError({
          reason: `a record line of ${lineBytes.length} bytes exceeded the ${MAX_HELPER_LINE_BYTES} byte limit`,
        }),
      );
    }

    // Decoded only once the whole line is in hand, so a multi-byte character
    // split across two chunks is never decoded half-formed.
    const line = textDecoder.decode(lineBytes).trim();
    if (line.length === 0) continue;

    const decoded = decodeHelperRecord(line);
    if (!Result.isSuccess(decoded)) {
      return Result.fail(decoded.failure);
    }

    const record = decoded.success;
    if (record.type !== "frame") {
      records.push({ record, payload: null });
      continue;
    }
    pending = { record, payload: new Uint8Array(record.payloadBytes), filled: 0 };
  }

  return Result.succeed({
    // Sliced rather than viewed so a small leftover line does not pin a whole
    // multi-megabyte chunk alive.
    state: { buffer: offset === 0 ? buffer : buffer.slice(offset), pending },
    records,
  });
};
