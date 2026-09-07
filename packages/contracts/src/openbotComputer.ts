import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformOs } from "./environment.ts";

/**
 * The human-facing view of the computer an environment's agents act on.
 *
 * Agents run as ordinary provider processes in the host's own signed-in
 * desktop session: one login session, one cursor, one frontmost app. There is
 * no per-agent virtual display, so the preview is a capture of that real
 * session rather than an isolated surface.
 */

/** Why a host can or cannot be previewed. `unsupported` is a property of the
    platform, `unavailable` of this particular host (missing tool, denied
    permission). `ready` is only ever claimed after a capture has actually
    succeeded on this server, so a host that has never been asked is `unknown`
    rather than optimistically ready. */
export const OpenbotComputerAvailability = Schema.Literals([
  "ready",
  "unknown",
  "unsupported",
  "unavailable",
]);
export type OpenbotComputerAvailability = typeof OpenbotComputerAvailability.Type;

/** Pixel sizes are null when the host reported a shape we could not parse. */
export const OpenbotComputerDisplay = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  widthPx: Schema.NullOr(Schema.Number),
  heightPx: Schema.NullOr(Schema.Number),
  main: Schema.Boolean,
});
export type OpenbotComputerDisplay = typeof OpenbotComputerDisplay.Type;

export const OpenbotComputerHost = Schema.Struct({
  label: Schema.String,
  platform: ExecutionEnvironmentPlatformOs,
});
export type OpenbotComputerHost = typeof OpenbotComputerHost.Type;

export const OpenbotComputerStatus = Schema.Struct({
  host: OpenbotComputerHost,
  /** Only one session kind exists today; naming it keeps the wire honest about
      what the preview shows rather than implying an isolated display. */
  session: Schema.Literal("signed-in-desktop"),
  availability: OpenbotComputerAvailability,
  /** Why the host is not `ready`, or a warning while it is. Null when there is
      nothing worth saying. */
  detail: Schema.NullOr(Schema.String),
  /** Null when the display list could not be read. */
  displays: Schema.NullOr(Schema.Array(OpenbotComputerDisplay)),
  /** When this server last captured the screen successfully, null if never.
      This is the evidence behind `ready`. */
  lastCaptureAt: Schema.NullOr(IsoDateTime),
  /** The raw failure text of the last capture attempt, null when the last
      attempt succeeded or none was made. `detail` is the human reading of it. */
  lastError: Schema.NullOr(Schema.String),
  checkedAt: IsoDateTime,
});
export type OpenbotComputerStatus = typeof OpenbotComputerStatus.Type;

export const OpenbotComputerSnapshotInput = Schema.Struct({
  /** Longest edge the server should downscale to before encoding. */
  maxWidthPx: Schema.optional(Schema.Int),
});
export type OpenbotComputerSnapshotInput = typeof OpenbotComputerSnapshotInput.Type;

export const OpenbotComputerSnapshot = Schema.Struct({
  mimeType: Schema.Literal("image/jpeg"),
  dataBase64: Schema.String,
  /** Absent when the encoded image's header could not be read. */
  widthPx: Schema.optional(Schema.Int),
  heightPx: Schema.optional(Schema.Int),
  capturedAt: IsoDateTime,
  /** Set when the capture looks like it may not show what the user expects,
      most importantly a macOS Screen Recording permission that was never
      granted. Null when the capture looks normal. */
  caveat: Schema.NullOr(Schema.String),
});
export type OpenbotComputerSnapshot = typeof OpenbotComputerSnapshot.Type;

export class OpenbotComputerError extends Schema.TaggedErrorClass<OpenbotComputerError>()(
  "OpenbotComputerError",
  {
    code: Schema.Literals(["unsupported", "capture_failed", "permission_denied"]),
    message: Schema.String,
  },
) {}
