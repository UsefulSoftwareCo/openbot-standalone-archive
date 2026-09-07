import {
  type OpenbotComputerDisplay,
  OpenbotComputerError,
  type OpenbotComputerSnapshot,
  type OpenbotComputerSnapshotInput,
  type OpenbotComputerStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

/**
 * The computer an environment's agents act on.
 *
 * Agents run as ordinary provider processes inside the host's signed-in
 * desktop session, so the only honest preview is a screenshot of that session.
 * Everything here is macOS-only today because the capture pipeline is
 * `screencapture` + `sips`; other platforms report `unsupported` rather than
 * pretending.
 */
export class OpenbotComputerService extends Context.Service<
  OpenbotComputerService,
  {
    readonly status: Effect.Effect<OpenbotComputerStatus>;
    readonly snapshot: (
      input: OpenbotComputerSnapshotInput,
    ) => Effect.Effect<OpenbotComputerSnapshot, OpenbotComputerError>;
  }
>()("t3/openbot/OpenbotComputerService") {}

export const SCREENCAPTURE_PATH = "/usr/sbin/screencapture";
const SIPS_PATH = "/usr/bin/sips";
const SYSTEM_PROFILER_PATH = "/usr/sbin/system_profiler";

const UNSUPPORTED_DETAIL = "Screen preview is only implemented for macOS hosts.";
const MISSING_TOOL_DETAIL = `This host has no ${SCREENCAPTURE_PATH}, so the screen cannot be captured.`;
const DISPLAYS_UNREADABLE_DETAIL =
  "The display list could not be read from system_profiler; the preview still works.";
/**
 * macOS does not report a denied Screen Recording permission: `screencapture`
 * exits 0 and writes a wallpaper-only image. A wallpaper JPEG compresses far
 * smaller than a desktop with windows and text, so size is the only signal we
 * have. It is a heuristic, and a genuinely empty desktop trips it too.
 */
export const PERMISSION_CAVEAT =
  "If the image shows only the desktop background, this server's parent process needs Screen Recording permission in System Settings › Privacy & Security.";

const DISPLAYS_CACHE_MS = 60_000;
/** Captures closer together than this reuse the previous image. */
export const MIN_CAPTURE_SPACING_MS = 1_000;
const SMALL_IMAGE_BYTES = 15 * 1024;
const MAX_BASE64_BYTES = 1_500_000;
const DEFAULT_MAX_WIDTH_PX = 1280;
const FALLBACK_MAX_WIDTH_PX = 960;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Runs one command to completion. The spawner is captured at layer build so
    the service's methods carry no context requirement of their own. */
const runCommand =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (executable: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(executable, [...args]));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout }),
          collectUint8StreamText({ stream: child.stderr }),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout.text, stderr: stderr.text, exitCode } satisfies CommandResult;
    }).pipe(Effect.scoped);

const firstNumber = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Reads the display list out of `system_profiler SPDisplaysDataType -json`.
 * Returns null when the payload is not the shape we know, so a macOS release
 * that renames a key degrades to "unknown displays" instead of an error.
 */
export function parseDisplays(json: string): ReadonlyArray<OpenbotComputerDisplay> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const cards = (parsed as Record<string, unknown>).SPDisplaysDataType;
  if (!Array.isArray(cards)) return null;
  const displays: Array<OpenbotComputerDisplay> = [];
  for (const card of cards) {
    if (typeof card !== "object" || card === null) continue;
    const attached = (card as Record<string, unknown>).spdisplays_ndrvs;
    if (!Array.isArray(attached)) continue;
    for (const entry of attached) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const name = typeof record._name === "string" ? record._name : "Display";
      const pixels = record._spdisplays_pixels;
      const [width, height] =
        typeof pixels === "string" ? pixels.split("x") : [undefined, undefined];
      displays.push({
        id:
          typeof record._spdisplays_displayID === "string"
            ? record._spdisplays_displayID
            : `display-${displays.length}`,
        name,
        widthPx: firstNumber(width),
        heightPx: firstNumber(height),
        main: record.spdisplays_main === "spdisplays_yes",
      });
    }
  }
  return displays.length === 0 ? null : displays;
}

/**
 * Width and height from a JPEG's first frame header. Avoids a second `sips`
 * process just to learn what we already hold in memory. Null when the bytes
 * are not a JPEG we can walk.
 */
export function readJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    // SOF0..SOF15, minus the two DHT/DAC/DNL markers that share the range.
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

interface CachedDisplays {
  readonly atMs: number;
  readonly displays: ReadonlyArray<OpenbotComputerDisplay> | null;
}

interface CachedSnapshot {
  readonly atMs: number;
  readonly snapshot: OpenbotComputerSnapshot;
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* ServerEnvironment;
  const run = runCommand(yield* ChildProcessSpawner.ChildProcessSpawner);
  const captureLock = yield* Semaphore.make(1);
  const displaysCache = yield* Ref.make<CachedDisplays | null>(null);
  const lastSnapshot = yield* Ref.make<CachedSnapshot | null>(null);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readDisplays = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(displaysCache);
    if (cached !== null && nowMs - cached.atMs < DISPLAYS_CACHE_MS) return cached.displays;
    const result = yield* run(SYSTEM_PROFILER_PATH, ["SPDisplaysDataType", "-json"]).pipe(
      Effect.orElseSucceed(() => null),
    );
    const displays = result === null || result.exitCode !== 0 ? null : parseDisplays(result.stdout);
    yield* Ref.set(displaysCache, { atMs: nowMs, displays });
    return displays;
  });

  const status: Effect.Effect<OpenbotComputerStatus> = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const host = { label: descriptor.label, platform: descriptor.platform.os } as const;
    const base = { host, session: "signed-in-desktop", checkedAt: yield* nowIso } as const;
    if (descriptor.platform.os !== "darwin") {
      return {
        ...base,
        availability: "unsupported",
        detail: UNSUPPORTED_DETAIL,
        displays: null,
      } satisfies OpenbotComputerStatus;
    }
    const capturable = yield* fs.exists(SCREENCAPTURE_PATH).pipe(Effect.orElseSucceed(() => false));
    if (!capturable) {
      return {
        ...base,
        availability: "unavailable",
        detail: MISSING_TOOL_DETAIL,
        displays: null,
      } satisfies OpenbotComputerStatus;
    }
    const displays = yield* readDisplays;
    return {
      ...base,
      availability: "ready",
      detail: displays === null ? DISPLAYS_UNREADABLE_DETAIL : null,
      displays,
    } satisfies OpenbotComputerStatus;
  });

  const captureFailed = (message: string) =>
    new OpenbotComputerError({ code: "capture_failed", message });

  /** Downscales in place. A `sips` that fails or is missing leaves the
      original file, which is still a correct (if larger) capture. */
  const resample = (file: string, maxWidthPx: number) =>
    run(SIPS_PATH, ["--resampleWidth", String(maxWidthPx), file]).pipe(Effect.ignore);

  const capture = (maxWidthPx: number) =>
    Effect.gen(function* () {
      const directory = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-openbot-computer-" })
        .pipe(Effect.mapError((cause) => captureFailed(`Could not open a temp file: ${cause}`)));
      const file = path.join(directory, "screen.jpg");
      const captured = yield* run(SCREENCAPTURE_PATH, ["-x", "-t", "jpg", file]).pipe(
        Effect.mapError((cause) => captureFailed(`screencapture could not run: ${cause}`)),
      );
      if (captured.exitCode !== 0) {
        const detail = captured.stderr.trim();
        return yield* captureFailed(
          `screencapture exited with ${captured.exitCode}${detail === "" ? "" : `: ${detail}`}`,
        );
      }
      yield* resample(file, maxWidthPx);
      const read = fs
        .readFile(file)
        .pipe(Effect.mapError((cause) => captureFailed(`Could not read the capture: ${cause}`)));
      let bytes = yield* read;
      let dataBase64 = Encoding.encodeBase64(bytes);
      if (dataBase64.length > MAX_BASE64_BYTES) {
        yield* resample(file, FALLBACK_MAX_WIDTH_PX);
        bytes = yield* read;
        dataBase64 = Encoding.encodeBase64(bytes);
      }
      const size = readJpegSize(bytes);
      return {
        mimeType: "image/jpeg",
        dataBase64,
        ...(size === null ? {} : { widthPx: size.width, heightPx: size.height }),
        capturedAt: yield* nowIso,
        caveat: bytes.length < SMALL_IMAGE_BYTES ? PERMISSION_CAVEAT : null,
      } satisfies OpenbotComputerSnapshot;
    }).pipe(Effect.scoped);

  const snapshot = (input: OpenbotComputerSnapshotInput) =>
    captureLock.withPermits(1)(
      Effect.gen(function* () {
        const descriptor = yield* environment.getDescriptor;
        if (descriptor.platform.os !== "darwin") {
          return yield* new OpenbotComputerError({
            code: "unsupported",
            message: UNSUPPORTED_DETAIL,
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const previous = yield* Ref.get(lastSnapshot);
        // Doubles as in-flight sharing: a caller that queued behind a running
        // capture arrives here well within the spacing window and gets it.
        if (previous !== null && nowMs - previous.atMs < MIN_CAPTURE_SPACING_MS) {
          return previous.snapshot;
        }
        const taken = yield* capture(input.maxWidthPx ?? DEFAULT_MAX_WIDTH_PX);
        yield* Ref.set(lastSnapshot, { atMs: yield* Clock.currentTimeMillis, snapshot: taken });
        return taken;
      }),
    );

  return OpenbotComputerService.of({ status, snapshot });
});

export const layer = Layer.effect(OpenbotComputerService, make);
