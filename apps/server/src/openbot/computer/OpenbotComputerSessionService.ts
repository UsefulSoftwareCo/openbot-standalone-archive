import {
  type OpenbotComputerAvailability,
  type OpenbotComputerController,
  type OpenbotComputerDisplay,
  type OpenbotComputerDisplayId,
  OpenbotComputerError,
  type OpenbotComputerInputEvent,
  type OpenbotComputerInputResult,
  type OpenbotComputerSetup,
  type OpenbotComputerSnapshot,
  type OpenbotComputerStatus,
  type OpenbotComputerStreamProfile,
  type OpenbotComputerStreamServerMessage,
  type OpenbotComputerStreamState,
  type OpenbotComputerWindow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import {
  ComputerBackend,
  type CaptureProfile,
  type ComputerBackendDescription,
  type ComputerFrame,
} from "./ComputerBackend.ts";
import {
  applyComputerInputEvents,
  coalesceComputerInputMoves,
  emptyComputerInputState,
  isComputerInputStateIdle,
  releaseEventsFor,
  type ComputerInputState,
} from "./ComputerInputState.ts";
import {
  OpenbotComputerSession,
  type ComputerInputSource,
  type ComputerViewer,
  type OpenbotComputerSessionShape,
} from "./OpenbotComputerSession.ts";

/**
 * The platform-neutral half of computer control: who is watching, who holds
 * the single input lease, which displays are being captured, and in what order
 * events reach the desktop. Everything platform specific is behind
 * `ComputerBackend`, so this whole file is testable against a fake.
 */

/** Said before any capture has been tried, because a host that has never been
    captured has produced no evidence either way. */
export const NOT_TRIED_DETAIL = "Preview not tried yet";

/** macOS refuses capture outright when Screen Recording was never granted to
    the process chain that launched this server, and it does not prompt on
    behalf of a background process. */
export const PERMISSION_DENIED_DETAIL =
  "macOS refused screen capture for this server. Grant Screen Recording to the app that launched the OpenBot server (System Settings › Privacy & Security › Screen Recording), then restart it.";

/** Attached to a snapshot taken while the capture grant is missing or
    unreadable. Never inferred from the image: on the macOS releases that
    answer a denied permission with a wallpaper-only picture, nothing in the
    result distinguishes that from an empty desktop. */
export const PERMISSION_CAVEAT =
  "Screen Recording permission is not confirmed for this server, so this image may show only the desktop background instead of the real screen. Grant it in System Settings › Privacy & Security › Screen Recording and restart the server.";

/** Input works through Accessibility on macOS; capture does not. Said while
    the host is otherwise ready so the UI can explain a dead pointer. */
export const ACCESSIBILITY_DENIED_DETAIL =
  "The host can be viewed but not controlled: grant Accessibility to the app that launched the OpenBot server (System Settings › Privacy & Security › Accessibility), then restart it.";

/** What a viewer sees when it sends input without holding the lease. */
export const NOT_CONTROLLING_REASON = "not controlling";

const DEFAULT_SNAPSHOT_MAX_WIDTH_PX = 1280;
const DEFAULT_STREAM_QUALITY = 0.7;
/**
 * Frames are dropped, never queued: a viewer on a slow link should see the
 * desktop as it is now, not replay a backlog. Two slots so a frame in flight
 * does not evict the one being written.
 */
const VIEWER_FRAME_BUFFER = 2;
/** Display hotplug and permission grants arrive as bursts of nudges; one
    recomposed status per burst is what a client can use. */
const STATUS_DEBOUNCE = "100 millis";

/** What this server process has actually observed about capturing this host.
    `availability` is derived from it, so `ready` can only follow a real
    capture. Not persisted: a restart is exactly when the answer can change. */
export interface ComputerCaptureOutcome {
  readonly lastCaptureAt: string | null;
  readonly lastError: string | null;
}

/** The pixel size of the encoded frames a viewer will receive, given the
    display it opened and the width it asked for. Downscale only: asking for
    more than the display has would invent detail. */
export function captureFrameSize(
  display: OpenbotComputerDisplay,
  maxWidthPx: number,
): { readonly widthPx: number; readonly heightPx: number } {
  if (display.widthPx <= maxWidthPx || display.widthPx <= 0) {
    return { widthPx: display.widthPx, heightPx: display.heightPx };
  }
  return {
    widthPx: maxWidthPx,
    heightPx: Math.max(1, Math.round((display.heightPx * maxWidthPx) / display.widthPx)),
  };
}

/** One capture per display serves every viewer of it, so it runs at the
    largest profile anyone asked for; a viewer that wanted less gets more than
    it needs rather than a second encode of the same screen. */
export function maxCaptureProfile(profiles: ReadonlyArray<CaptureProfile>): CaptureProfile | null {
  const first = profiles[0];
  if (first === undefined) return null;
  return profiles.slice(1).reduce<CaptureProfile>(
    (widest, profile) => ({
      maxWidthPx: Math.max(widest.maxWidthPx, profile.maxWidthPx),
      fps: Math.max(widest.fps, profile.fps),
      quality: Math.max(widest.quality, profile.quality),
    }),
    first,
  );
}

const sameProfile = (left: CaptureProfile, right: CaptureProfile): boolean =>
  left.maxWidthPx === right.maxWidthPx && left.fps === right.fps && left.quality === right.quality;

const toCaptureProfile = (profile: OpenbotComputerStreamProfile): CaptureProfile => ({
  maxWidthPx: profile.maxWidthPx,
  fps: profile.fps,
  quality: profile.quality ?? DEFAULT_STREAM_QUALITY,
});

function setupDetail(setup: OpenbotComputerSetup): string {
  const missing = setup.dependencies.filter((dependency) => !dependency.present);
  const missingNames = missing.map((dependency) => dependency.name).join(", ");
  const notes = setup.notes.join(" ");
  if (missingNames === "")
    return notes === "" ? "This host is not set up for screen control." : notes;
  return `This host is missing ${missingNames}.${notes === "" ? "" : ` ${notes}`}`;
}

/**
 * The one place `availability` is decided, kept pure so the ladder of reasons
 * is testable without a host. `describeError` wins over everything: a backend
 * that cannot even describe itself has told us nothing else worth reading.
 */
export function computerAvailability(input: {
  readonly platform: "darwin" | "linux" | "unsupported";
  readonly description: ComputerBackendDescription | null;
  readonly describeError: string | null;
  readonly outcome: ComputerCaptureOutcome;
}): { readonly availability: OpenbotComputerAvailability; readonly detail: string | null } {
  const { description, describeError, outcome } = input;
  if (description === null) {
    return {
      availability: input.platform === "unsupported" ? "unsupported" : "unavailable",
      detail: describeError,
    };
  }
  if (input.platform === "unsupported") {
    return { availability: "unsupported", detail: description.unavailableReason };
  }
  if (description.unavailableReason !== null) {
    return { availability: "unavailable", detail: description.unavailableReason };
  }
  if (description.setup !== null && !description.setup.ready) {
    return { availability: "unavailable", detail: setupDetail(description.setup) };
  }
  if (description.permissions.screenCapture === "denied") {
    return {
      availability: "unavailable",
      detail: description.permissions.detail ?? PERMISSION_DENIED_DETAIL,
    };
  }
  if (outcome.lastError !== null) {
    return { availability: "unavailable", detail: `The last capture failed: ${outcome.lastError}` };
  }
  if (outcome.lastCaptureAt === null) {
    return { availability: "unknown", detail: NOT_TRIED_DETAIL };
  }
  return {
    availability: "ready",
    detail: description.permissions.accessibility === "denied" ? ACCESSIBILITY_DENIED_DETAIL : null,
  };
}

/** Who holds the single input lease, and the display their input is aimed at
    so a display disappearing can free it. */
interface Lease {
  readonly source: ComputerInputSource;
  readonly displayId: OpenbotComputerDisplayId | null;
  readonly since: string;
}

interface ViewerRecord {
  readonly viewerId: string;
  readonly label: string;
  readonly canControl: boolean;
  readonly displayId: OpenbotComputerDisplayId | null;
  readonly profile: CaptureProfile;
  readonly control: Queue.Queue<OpenbotComputerStreamServerMessage, Cause.Done>;
  readonly frames: Queue.Queue<ComputerFrame, Cause.Done>;
}

interface CaptureRecord {
  readonly profile: CaptureProfile;
  readonly scope: Scope.Closeable;
}

const sourceKey = (source: ComputerInputSource): string =>
  source.kind === "viewer" ? `viewer:${source.viewerId}` : `agent:${source.threadId}`;

const controllerOf = (lease: Lease | null): OpenbotComputerController | null =>
  lease === null
    ? null
    : { kind: lease.source.kind, label: lease.source.label, since: lease.since };

const heldBy = (lease: Lease | null, source: ComputerInputSource): boolean =>
  lease !== null && sourceKey(lease.source) === sourceKey(source);

const rejectEvery = (
  events: ReadonlyArray<OpenbotComputerInputEvent>,
  reason: string,
): OpenbotComputerInputResult => ({
  delivered: 0,
  rejected: events.map((_, index) => ({ index, reason })),
});

/** A capture failure that names a permission gets its own stream state, so the
    client can offer the fix instead of a generic error. */
const streamStateForError = (error: OpenbotComputerError): OpenbotComputerStreamState =>
  error.code === "permission_denied" ? "permission-denied" : "error";

export const make = Effect.gen(function* () {
  const backend = yield* ComputerBackend;
  const environment = yield* ServerEnvironment;
  // Captures outlive the fiber that started them but not the service, so their
  // scopes and the fibers that close them are anchored here.
  const serviceScope = yield* Effect.scope;

  const viewers = yield* Ref.make<ReadonlyMap<string, ViewerRecord>>(new Map());
  const captures = yield* Ref.make<ReadonlyMap<string, CaptureRecord>>(new Map());
  const lease = yield* Ref.make<Lease | null>(null);
  const pressed = yield* Ref.make<ReadonlyMap<string, ComputerInputState>>(new Map());
  const displayLocks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
  const outcome = yield* Ref.make<ComputerCaptureOutcome>({
    lastCaptureAt: null,
    lastError: null,
  });
  const viewerSequence = yield* Ref.make(0);
  // Viewer registration and capture reconciliation read the viewer map and act
  // on the result, so they take this rather than racing two Ref updates.
  const bookkeeping = yield* Semaphore.make(1);
  const nudges = yield* PubSub.sliding<void>(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const publishStatus = PubSub.publish(nudges, undefined).pipe(Effect.asVoid);

  const viewerList = Ref.get(viewers).pipe(Effect.map((map) => [...map.values()]));

  const toViewer = (record: ViewerRecord): ComputerInputSource => ({
    kind: "viewer",
    viewerId: record.viewerId,
    label: record.label,
  });

  const sendTo = (record: ViewerRecord, message: OpenbotComputerStreamServerMessage) =>
    Queue.offer(record.control, message).pipe(Effect.asVoid);

  const sendToDisplay = (
    displayId: OpenbotComputerDisplayId,
    message: OpenbotComputerStreamServerMessage,
  ) =>
    viewerList.pipe(
      Effect.flatMap((records) =>
        Effect.forEach(
          records.filter((record) => record.displayId === displayId),
          (record) => sendTo(record, message),
          { discard: true },
        ),
      ),
    );

  /** Everyone watching learns who is controlling, and whether it is them. */
  const broadcastController = Effect.gen(function* () {
    const current = yield* Ref.get(lease);
    const controller = controllerOf(current);
    const records = yield* viewerList;
    yield* Effect.forEach(
      records,
      (record) =>
        sendTo(record, {
          type: "controller",
          controller,
          controlling: heldBy(current, toViewer(record)),
        }),
      { discard: true },
    );
  });

  // ------------------------------------------------------------------ input

  const displayLock = (displayId: OpenbotComputerDisplayId) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(displayLocks)).get(displayId);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(displayLocks, (map) => {
        const raced = map.get(displayId);
        if (raced !== undefined) return [raced, map];
        return [created, new Map(map).set(displayId, created)];
      });
    });

  const withDisplayLock =
    (displayId: OpenbotComputerDisplayId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OpenbotComputerError, R> =>
      displayLock(displayId).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

  /**
   * Hands one batch to the backend and folds what it accepted into the
   * source's held state. Callers hold the display lock, which is what makes
   * batches from different sources land whole and in order.
   */
  const deliverLocked = (
    displayId: OpenbotComputerDisplayId,
    source: ComputerInputSource,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) =>
    Effect.gen(function* () {
      const coalesced = coalesceComputerInputMoves(events);
      const result = yield* backend.input(displayId, coalesced.events);
      const rejectedIndices = new Set(result.rejected.map((rejection) => rejection.index));
      const delivered = coalesced.events.filter((_, index) => !rejectedIndices.has(index));
      const key = sourceKey(source);
      yield* Ref.update(pressed, (map) =>
        new Map(map).set(
          key,
          applyComputerInputEvents(map.get(key) ?? emptyComputerInputState, delivered),
        ),
      );
      return {
        delivered: result.delivered,
        // Indices come back against the coalesced batch; the caller only ever
        // saw its own, so translate before acknowledging.
        rejected: result.rejected.map((rejection) => ({
          index: coalesced.sourceIndices[rejection.index] ?? rejection.index,
          reason: rejection.reason,
        })),
      } satisfies OpenbotComputerInputResult;
    });

  /** Puts back whatever this source is still holding. Best effort: a backend
      that is already gone cannot leave a key stuck either. */
  const releasePressed = (
    source: ComputerInputSource,
    displayId: OpenbotComputerDisplayId | null,
  ) =>
    Effect.gen(function* () {
      const key = sourceKey(source);
      const state = yield* Ref.modify(pressed, (map) => {
        const held = map.get(key) ?? emptyComputerInputState;
        if (!map.has(key)) return [held, map];
        const next = new Map(map);
        next.delete(key);
        return [held, next];
      });
      if (displayId === null || isComputerInputStateIdle(state)) return;
      yield* backend.input(displayId, releaseEventsFor(state)).pipe(Effect.ignore);
    });

  // ------------------------------------------------------------------ lease

  const takeLease = (source: ComputerInputSource, displayId: OpenbotComputerDisplayId | null) =>
    Effect.gen(function* () {
      const since = yield* nowIso;
      const taken = yield* Ref.modify(lease, (current) => {
        if (current === null) return [null, { source, displayId, since }];
        if (sourceKey(current.source) === sourceKey(source)) {
          return [null, { ...current, displayId }];
        }
        return [current.source.label, current];
      });
      if (taken !== null) {
        return yield* new OpenbotComputerError({
          code: "not_controlling",
          message: `Another controller (${taken}) is holding this computer. Ask them to stop controlling before taking over.`,
        });
      }
      yield* broadcastController;
      yield* publishStatus;
    });

  const releaseLease = (source: ComputerInputSource) =>
    Effect.gen(function* () {
      const released = yield* Ref.modify(lease, (current) =>
        heldBy(current, source) ? [current, null] : [null, current],
      );
      if (released === null) return;
      yield* releasePressed(source, released.displayId);
      yield* broadcastController;
      yield* publishStatus;
    });

  // ---------------------------------------------------------------- capture

  const recordFrameCaptured = (capturedAtMs: number) =>
    Effect.gen(function* () {
      const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(capturedAtMs));
      const changed = yield* Ref.modify(outcome, (current) => [
        current.lastCaptureAt === null || current.lastError !== null,
        { lastCaptureAt: capturedAt, lastError: null },
      ]);
      // Every frame updates the evidence, but only the transition out of
      // "never captured" or "last one failed" is worth a status push.
      if (changed) yield* publishStatus;
    });

  const recordCaptureFailure = (message: string) =>
    Ref.update(outcome, (current) => ({ ...current, lastError: message })).pipe(
      Effect.andThen(publishStatus),
    );

  /** Detaches every viewer of a display that is no longer capturable and frees
      a lease pointed at it. Callers hold `bookkeeping`. */
  const abandonDisplayLocked = (
    displayId: OpenbotComputerDisplayId,
    state: OpenbotComputerStreamState,
    message: string | null,
  ) =>
    Effect.gen(function* () {
      const affected = (yield* viewerList).filter((record) => record.displayId === displayId);
      yield* Effect.forEach(
        affected,
        (record) => sendTo(record, { type: "status", state, message }),
        {
          discard: true,
        },
      );
      yield* Ref.update(viewers, (map) => {
        const next = new Map(map);
        for (const record of affected) next.set(record.viewerId, { ...record, displayId: null });
        return next;
      });
      const current = yield* Ref.get(lease);
      if (
        current !== null &&
        (current.displayId === displayId ||
          affected.some((record) => heldBy(current, toViewer(record))))
      ) {
        yield* releaseLease(current.source);
      }
    });

  const stopCaptureLocked = (displayId: OpenbotComputerDisplayId) =>
    Effect.gen(function* () {
      const stopped = yield* Ref.modify(captures, (map) => {
        const existing = map.get(displayId);
        if (existing === undefined) return [null, map];
        const next = new Map(map);
        next.delete(displayId);
        return [existing, next];
      });
      if (stopped !== null) yield* Scope.close(stopped.scope, Exit.void);
    });

  /**
   * Called from the capture fiber when the backend's stream ends: the display
   * went away, or capture broke. Closing the capture scope here would
   * interrupt the fiber running this, so the close is handed to the service
   * scope instead.
   */
  const captureEnded = (displayId: OpenbotComputerDisplayId, error: OpenbotComputerError | null) =>
    bookkeeping.withPermits(1)(
      Effect.gen(function* () {
        const stopped = yield* Ref.modify(captures, (map) => {
          const existing = map.get(displayId);
          if (existing === undefined) return [null, map];
          const next = new Map(map);
          next.delete(displayId);
          return [existing, next];
        });
        if (error !== null) yield* recordCaptureFailure(error.message);
        yield* abandonDisplayLocked(
          displayId,
          error === null ? "display-gone" : streamStateForError(error),
          error === null ? "This display is no longer available." : error.message,
        );
        yield* publishStatus;
        if (stopped !== null) {
          yield* Effect.forkIn(Scope.close(stopped.scope, Exit.void), serviceScope);
        }
      }),
    );

  const startCaptureLocked = (displayId: OpenbotComputerDisplayId, profile: CaptureProfile) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Effect.match(
        backend.capture(displayId, profile).pipe(Scope.provide(scope)),
        {
          onFailure: (error: OpenbotComputerError) => ({ ok: false as const, error }),
          onSuccess: (frames: Stream.Stream<ComputerFrame, OpenbotComputerError>) => ({
            ok: true as const,
            frames,
          }),
        },
      );
      if (!started.ok) {
        yield* Scope.close(scope, Exit.void);
        yield* recordCaptureFailure(started.error.message);
        yield* abandonDisplayLocked(
          displayId,
          streamStateForError(started.error),
          started.error.message,
        );
        return;
      }
      yield* Ref.update(captures, (map) => new Map(map).set(displayId, { profile, scope }));
      yield* started.frames.pipe(
        Stream.runForEach((frame) =>
          recordFrameCaptured(frame.capturedAtMs).pipe(
            Effect.andThen(
              viewerList.pipe(
                Effect.flatMap((records) =>
                  Effect.forEach(
                    records.filter((record) => record.displayId === displayId),
                    (record) => Queue.offer(record.frames, frame),
                    { discard: true },
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.matchCauseEffect({
          onSuccess: () => captureEnded(displayId, null),
          onFailure: (cause: Cause.Cause<OpenbotComputerError>) =>
            // Interruption is the session closing this capture on purpose; the
            // viewers already know why.
            Cause.hasInterrupts(cause)
              ? Effect.void
              : captureEnded(
                  displayId,
                  Option.getOrElse(
                    Cause.findErrorOption(cause),
                    () =>
                      new OpenbotComputerError({
                        code: "capture_failed",
                        message: "The capture stopped unexpectedly.",
                      }),
                  ),
                ),
        }),
        Effect.forkIn(scope),
      );
      yield* sendToDisplay(displayId, { type: "status", state: "capturing", message: null });
    });

  /** One capture per display, at the widest profile its viewers asked for, and
      none at all when nobody is watching. Callers hold `bookkeeping`. */
  const reconcileCaptureLocked = (displayId: OpenbotComputerDisplayId) =>
    Effect.gen(function* () {
      const watching = (yield* viewerList).filter((record) => record.displayId === displayId);
      const wanted = maxCaptureProfile(watching.map((record) => record.profile));
      const existing = (yield* Ref.get(captures)).get(displayId);
      if (wanted === null) {
        yield* stopCaptureLocked(displayId);
        return;
      }
      if (existing !== undefined && sameProfile(existing.profile, wanted)) return;
      if (existing !== undefined) {
        yield* stopCaptureLocked(displayId);
        yield* sendToDisplay(displayId, { type: "status", state: "superseded", message: null });
      }
      yield* startCaptureLocked(displayId, wanted);
    });

  // ----------------------------------------------------------------- status

  const describeNow = Effect.match(backend.describe, {
    onFailure: (error: OpenbotComputerError) => ({
      description: null,
      describeError: error.message,
    }),
    onSuccess: (description: ComputerBackendDescription) => ({
      description,
      describeError: null,
    }),
  });

  const status: Effect.Effect<OpenbotComputerStatus> = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const { description, describeError } = yield* describeNow;
    const displays = yield* backend.listDisplays.pipe(Effect.orElseSucceed(() => []));
    // A window list that cannot be read is not a reason to lose the rest of the
    // status; the empty array is what the contract promises in that case.
    const windows: ReadonlyArray<OpenbotComputerWindow> =
      description?.capabilities.windows === true
        ? yield* backend.listWindows.pipe(Effect.orElseSucceed(() => []))
        : [];
    const captureOutcome = yield* Ref.get(outcome);
    const { availability, detail } = computerAvailability({
      platform: backend.platform,
      description,
      describeError,
      outcome: captureOutcome,
    });
    return {
      host: { label: descriptor.label, platform: descriptor.platform.os },
      session: description?.session ?? "unsupported",
      availability,
      detail,
      permissions: description?.permissions ?? {
        screenCapture: "unknown",
        accessibility: "unknown",
        detail: describeError,
      },
      setup: description?.setup ?? null,
      capabilities: description?.capabilities ?? {
        stream: false,
        input: false,
        windows: false,
        focusWindow: false,
        managedDisplays: false,
        launchApp: false,
      },
      displays,
      windows,
      controller: controllerOf(yield* Ref.get(lease)),
      lastCaptureAt: captureOutcome.lastCaptureAt,
      lastError: captureOutcome.lastError,
      checkedAt: yield* nowIso,
    } satisfies OpenbotComputerStatus;
  });

  const statusChanges: Stream.Stream<OpenbotComputerStatus> = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first status is composed, so a change that lands
      // while it is being read still produces a follow-up rather than a client
      // sitting on a stale snapshot.
      const subscription = yield* PubSub.subscribe(nudges);
      const first = yield* status;
      return Stream.concat(
        Stream.make(first),
        Stream.merge(Stream.fromSubscription(subscription), backend.changes).pipe(
          Stream.debounce(STATUS_DEBOUNCE),
          Stream.mapEffect(() => status),
        ),
      );
    }),
  );

  // --------------------------------------------------------------- displays

  const findDisplay = (displayId: OpenbotComputerDisplayId) =>
    backend.listDisplays.pipe(
      Effect.flatMap((displays) => {
        const display = displays.find((candidate) => candidate.id === displayId);
        return display === undefined
          ? new OpenbotComputerError({
              code: "display_not_found",
              message: `This host has no display ${displayId}.`,
            })
          : Effect.succeed(display);
      }),
    );

  const mainDisplay = backend.listDisplays.pipe(
    Effect.flatMap((displays) => {
      const display = displays.find((candidate) => candidate.main) ?? displays[0];
      return display === undefined
        ? new OpenbotComputerError({
            code: "display_not_found",
            message: "This host reports no displays to capture.",
          })
        : Effect.succeed(display);
    }),
  );

  const snapshot: OpenbotComputerSessionShape["snapshot"] = (input) =>
    Effect.gen(function* () {
      const display =
        input.displayId === undefined ? yield* mainDisplay : yield* findDisplay(input.displayId);
      const frame = yield* backend
        .screenshot(display.id, input.maxWidthPx ?? DEFAULT_SNAPSHOT_MAX_WIDTH_PX)
        .pipe(Effect.tapError((error) => recordCaptureFailure(error.message)));
      const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(frame.capturedAtMs));
      yield* Ref.set(outcome, { lastCaptureAt: capturedAt, lastError: null });
      const { description } = yield* describeNow;
      // `not-applicable` is a platform with no such gate, which is not a
      // reason to doubt the image; only a denial or an unreadable grant is.
      const capture = description?.permissions.screenCapture ?? "unknown";
      return {
        mimeType: "image/jpeg",
        dataBase64: Encoding.encodeBase64(frame.jpeg),
        widthPx: frame.widthPx,
        heightPx: frame.heightPx,
        displayId: display.id,
        capturedAt,
        caveat: capture === "denied" || capture === "unknown" ? PERMISSION_CAVEAT : null,
      } satisfies OpenbotComputerSnapshot;
    });

  const createDisplay: OpenbotComputerSessionShape["createDisplay"] = (input) =>
    backend.createDisplay(input).pipe(Effect.tap(() => publishStatus));

  const destroyDisplay: OpenbotComputerSessionShape["destroyDisplay"] = (displayId) =>
    backend.destroyDisplay(displayId).pipe(
      Effect.andThen(
        bookkeeping.withPermits(1)(
          Effect.gen(function* () {
            yield* abandonDisplayLocked(displayId, "display-gone", "This display was destroyed.");
            yield* stopCaptureLocked(displayId);
          }),
        ),
      ),
      Effect.andThen(publishStatus),
    );

  // ---------------------------------------------------------------- viewers

  const getViewer = (viewerId: string) =>
    Ref.get(viewers).pipe(
      Effect.flatMap((map) => {
        const record = map.get(viewerId);
        return record === undefined
          ? new OpenbotComputerError({
              code: "backend_unavailable",
              message: "This viewer is no longer attached.",
            })
          : Effect.succeed(record);
      }),
    );

  const detachViewer = (viewerId: string) =>
    Effect.gen(function* () {
      const removed = yield* bookkeeping.withPermits(1)(
        Ref.modify(viewers, (map) => {
          const record = map.get(viewerId);
          if (record === undefined) return [null, map];
          const next = new Map(map);
          next.delete(viewerId);
          return [record, next];
        }),
      );
      if (removed === null) return;
      yield* releaseLease(toViewer(removed));
      yield* releasePressed(toViewer(removed), removed.displayId);
      if (removed.displayId !== null) {
        yield* bookkeeping.withPermits(1)(reconcileCaptureLocked(removed.displayId));
      }
      yield* Queue.end(removed.control);
      yield* Queue.end(removed.frames);
    });

  const attachViewer: OpenbotComputerSessionShape["attachViewer"] = (input) =>
    Effect.gen(function* () {
      const sequence = yield* Ref.updateAndGet(viewerSequence, (current) => current + 1);
      const viewerId = `viewer-${sequence}`;
      const control = yield* Queue.make<OpenbotComputerStreamServerMessage, Cause.Done>();
      const frames = yield* Queue.sliding<ComputerFrame, Cause.Done>(VIEWER_FRAME_BUFFER);
      const record: ViewerRecord = {
        viewerId,
        label: input.label,
        canControl: input.canControl,
        displayId: null,
        profile: { maxWidthPx: 0, fps: 0, quality: 0 },
        control,
        frames,
      };
      yield* bookkeeping.withPermits(1)(
        Ref.update(viewers, (map) => new Map(map).set(viewerId, record)),
      );
      yield* Effect.addFinalizer(() => detachViewer(viewerId));
      const source: ComputerInputSource = { kind: "viewer", viewerId, label: input.label };

      const open: ComputerViewer["open"] = (displayId, profile) =>
        Effect.gen(function* () {
          const display = yield* findDisplay(displayId);
          const wanted = toCaptureProfile(profile);
          const previous = yield* Ref.modify(viewers, (map) => {
            const current = map.get(viewerId);
            if (current === undefined) return [null, map];
            return [
              current.displayId,
              new Map(map).set(viewerId, { ...current, displayId, profile: wanted }),
            ];
          });
          const size = captureFrameSize(display, wanted.maxWidthPx);
          const current = yield* Ref.get(lease);
          yield* Queue.offer(
            control,
            previous === null
              ? {
                  type: "hello",
                  viewerId,
                  display,
                  frameWidthPx: size.widthPx,
                  frameHeightPx: size.heightPx,
                  fps: wanted.fps,
                  encoding: "image/jpeg",
                  controller: controllerOf(current),
                  controlling: heldBy(current, source),
                }
              : {
                  type: "geometry",
                  display,
                  frameWidthPx: size.widthPx,
                  frameHeightPx: size.heightPx,
                },
          );
          yield* bookkeeping.withPermits(1)(
            Effect.gen(function* () {
              if (previous !== null && previous !== displayId) {
                yield* reconcileCaptureLocked(previous);
              }
              yield* reconcileCaptureLocked(displayId);
            }),
          );
        });

      const takeControl = Effect.gen(function* () {
        if (!input.canControl) {
          return yield* new OpenbotComputerError({
            code: "not_controlling",
            message:
              "This connection may watch the computer but not control it. It needs the orchestration:operate scope.",
          });
        }
        const record_ = yield* getViewer(viewerId);
        yield* takeLease(source, record_.displayId);
      });

      const viewerInput: ComputerViewer["input"] = (events) =>
        Effect.gen(function* () {
          const record_ = yield* getViewer(viewerId);
          if (record_.displayId === null) {
            return yield* new OpenbotComputerError({
              code: "display_not_found",
              message: "Open a display before sending input.",
            });
          }
          if (!heldBy(yield* Ref.get(lease), source)) {
            return rejectEvery(events, NOT_CONTROLLING_REASON);
          }
          return yield* withDisplayLock(record_.displayId)(
            deliverLocked(record_.displayId, source, events),
          );
        });

      return {
        viewerId,
        messages: Stream.merge(Stream.fromQueue(control), Stream.fromQueue(frames)),
        open,
        takeControl,
        releaseControl: releaseLease(source),
        input: viewerInput,
      } satisfies ComputerViewer;
    });

  // ------------------------------------------------------------------ input

  const agentInput: OpenbotComputerSessionShape["agentInput"] = (source, displayId, events) =>
    withDisplayLock(displayId)(
      // The lease is taken for the batch and dropped with it, so a human who
      // takes control between two agent calls simply wins the next one.
      takeLease(source, displayId).pipe(
        Effect.andThen(deliverLocked(displayId, source, events)),
        Effect.ensuring(releaseLease(source)),
      ),
    );

  const viewerRpcInput: OpenbotComputerSessionShape["viewerInput"] = (source, displayId, events) =>
    Effect.gen(function* () {
      if (!heldBy(yield* Ref.get(lease), source)) {
        return rejectEvery(events, NOT_CONTROLLING_REASON);
      }
      return yield* withDisplayLock(displayId)(deliverLocked(displayId, source, events));
    });

  const control: OpenbotComputerSessionShape["control"] = (source, action) =>
    (action === "take" ? takeLease(source, null) : releaseLease(source)).pipe(
      Effect.andThen(status),
    );

  return OpenbotComputerSession.of({
    status,
    statusChanges,
    listDisplays: backend.listDisplays,
    listWindows: (displayId) =>
      Effect.gen(function* () {
        const description = yield* backend.describe;
        if (!description.capabilities.windows) return [];
        const windows = yield* backend.listWindows;
        return displayId === undefined
          ? windows
          : windows.filter((window) => window.displayId === displayId);
      }),
    focusWindow: backend.focusWindow,
    snapshot,
    attachViewer,
    agentInput,
    viewerInput: viewerRpcInput,
    control,
    controller: Ref.get(lease).pipe(Effect.map(controllerOf)),
    createDisplay,
    destroyDisplay,
    launch: backend.launch,
  });
});

export const layer = Layer.effect(OpenbotComputerSession, make);
