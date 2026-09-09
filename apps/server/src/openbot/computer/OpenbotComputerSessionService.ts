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
import * as Fiber from "effect/Fiber";
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
 *
 * There is one shared pointer and one keyboard, so there is one host mutex.
 * Taking or releasing the lease, delivering a batch, folding what a source has
 * pressed, putting it back, and switching a viewer's display are all one
 * ordered transition under `hostLock`; nothing reaches the backend without the
 * lock, and every batch rechecks who it is and where it is aimed at the moment
 * it finally has it.
 *
 * Cancellation is the other half of that contract. Delivery runs on its own
 * fiber, so stopping control, closing a viewer, switching displays, or losing a
 * display interrupts a minute of queued text instead of waiting it out, then
 * puts the desktop back with the backend's own `release-all`.
 */

/** Said before any capture has been tried, because a host that has never been
    captured has produced no evidence either way. */
export const NOT_TRIED_DETAIL = "Preview not tried yet";

/** The helper is the app macOS attaches the grants to: it is what appears in
    the permission lists, whatever launched the server. */
const HELPER_NAME = "T3 Computer Helper";

/** macOS refuses capture outright until Screen Recording is granted to the
    helper. No restart: the helper re-checks the grant, so the next preview is
    the test. */
export const PERMISSION_DENIED_DETAIL = `macOS refused screen capture. Grant Screen Recording to ${HELPER_NAME} (codes.t3.openbot.computer-helper) in System Settings › Privacy & Security › Screen Recording, then try the preview again.`;

/** Attached to a snapshot taken while the capture grant is missing or
    unreadable. Never inferred from the image: on the macOS releases that
    answer a denied permission with a wallpaper-only picture, nothing in the
    result distinguishes that from an empty desktop. */
export const PERMISSION_CAVEAT = `Screen Recording permission is not confirmed, so this image may show only the desktop background instead of the real screen. Grant it to ${HELPER_NAME} in System Settings › Privacy & Security › Screen Recording and take it again.`;

/** Input works through Accessibility on macOS; capture does not. Said while
    the host is otherwise ready so the UI can explain a dead pointer. Only used
    when the backend offered no words of its own. */
export const ACCESSIBILITY_DENIED_DETAIL = `The host can be viewed but not controlled: grant Accessibility to ${HELPER_NAME} (codes.t3.openbot.computer-helper) in System Settings › Privacy & Security › Accessibility. It takes effect on the next attempt.`;

/** What a viewer sees when it sends input without holding the lease. */
export const NOT_CONTROLLING_REASON = "not controlling";

/** What a viewer sees when its batch reached the host lock aimed at a display
    it has since left. */
export const DISPLAY_CHANGED_REASON = "display changed";

/** What a viewer sees when its batch was cut short by stopping control, a
    closing connection, or a display going away. */
export const INPUT_CANCELLED_REASON = "cancelled";

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

/** The event that puts a display back to nothing-held whoever pressed it. Used
    where an interrupted batch means the session can no longer name what it
    left down. */
const RELEASE_ALL: OpenbotComputerInputEvent = { type: "release-all" };

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
 *
 * A backend that names its own fix always wins over the copy here, which is
 * only the fallback for a host that reports a denial without words. Platforms
 * with no such gate report `not-applicable` and get no permission copy at all.
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
    detail:
      description.permissions.accessibility === "denied"
        ? (description.permissions.detail ?? ACCESSIBILITY_DENIED_DETAIL)
        : null,
  };
}

/** Who holds the single input lease. The lease is not per display: the person
    who has control keeps it while they move between screens. */
interface Lease {
  readonly source: ComputerInputSource;
  /** `leaseKey(source)`, kept so authorization survives the source's other
      fields changing between connections of the same person. */
  readonly key: string;
  /** `sourceKey` of the connection that took it. Every connection of the same
      session is authorized by `key`, but only this one's disconnect is that
      person letting go: a second tab or a view-only socket closing must not
      take control away from the connection that is using it. */
  readonly ownerConnection: string;
  readonly since: string;
}

/** What one source has down on one display, and whether the session can still
    name it. A batch that was interrupted mid-flight leaves the display
    uncertain, and uncertainty is released with `release-all` rather than a
    list of ups the session only half believes. */
interface DisplayHold {
  readonly state: ComputerInputState;
  readonly uncertain: boolean;
}

interface HeldRecord {
  readonly source: ComputerInputSource;
  /** Every display this source has delivered to, or tried to. */
  readonly displays: ReadonlyMap<OpenbotComputerDisplayId, DisplayHold>;
}

/** The fiber carrying one source's batch, so stopping control can interrupt it
    instead of waiting for a long `text` event to finish typing. */
interface InflightDelivery {
  readonly source: ComputerInputSource;
  readonly fiber: Fiber.Fiber<OpenbotComputerInputResult, OpenbotComputerError>;
}

interface ViewerRecord {
  readonly viewerId: string;
  readonly sessionId: string;
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
  /** The most recent frame this capture produced, handed to a viewer that joins
      a display nothing is happening on. The slot belongs to the capture rather
      than the display, so stopping the capture or restarting it at another
      profile drops the stale picture along with the record; nobody has to
      remember to clear it. */
  readonly latest: Ref.Ref<ComputerFrame | null>;
}

/** One connection. Two tabs of the same person hold their own keys down. */
const sourceKey = (source: ComputerInputSource): string =>
  source.kind === "viewer" ? `viewer:${source.viewerId}` : `agent:${source.threadId}`;

/** One controller. A person's frame socket and their RPC socket share this, so
    the lease one of them took authorizes the other. */
const leaseKey = (source: ComputerInputSource): string =>
  source.kind === "viewer" ? `viewer:${source.sessionId}` : `agent:${source.threadId}`;

const controllerOf = (lease: Lease | null): OpenbotComputerController | null =>
  lease === null
    ? null
    : { kind: lease.source.kind, label: lease.source.label, since: lease.since };

/** Whether this source may act under the lease: true for every connection of
    the session that holds it. */
const heldBy = (lease: Lease | null, source: ComputerInputSource): boolean =>
  lease !== null && lease.key === leaseKey(source);

/** Whether this connection is the one that took the lease. Only used where a
    connection going away decides the lease's fate; asking anything else is
    authorization, which is `heldBy`. */
const ownedByConnection = (lease: Lease | null, key: string): boolean =>
  lease !== null && lease.ownerConnection === key;

const rejectEvery = (
  events: ReadonlyArray<OpenbotComputerInputEvent>,
  reason: string,
): OpenbotComputerInputResult => ({
  delivered: 0,
  rejected: events.map((_, index) => ({ index, reason })),
});

const notControlling = (label: string) =>
  new OpenbotComputerError({
    code: "not_controlling",
    message: `Another controller (${label}) is holding this computer. Ask them to stop controlling before taking over.`,
  });

/** A capture failure that names a permission gets its own stream state, so the
    client can offer the fix instead of a generic error. */
const streamStateForError = (error: OpenbotComputerError): OpenbotComputerStreamState =>
  error.code === "permission_denied" ? "permission-denied" : "error";

/** What a batch may do once it finally holds the host lock. */
type DeliveryPlan =
  | { readonly kind: "deliver"; readonly displayId: OpenbotComputerDisplayId }
  | { readonly kind: "reject"; readonly reason: string };

export const make = Effect.gen(function* () {
  const backend = yield* ComputerBackend;
  const environment = yield* ServerEnvironment;
  // Captures outlive the fiber that started them but not the service, so their
  // scopes and the fibers that close them are anchored here.
  const serviceScope = yield* Effect.scope;

  const viewers = yield* Ref.make<ReadonlyMap<string, ViewerRecord>>(new Map());
  const captures = yield* Ref.make<ReadonlyMap<string, CaptureRecord>>(new Map());
  const lease = yield* Ref.make<Lease | null>(null);
  const held = yield* Ref.make<ReadonlyMap<string, HeldRecord>>(new Map());
  const inflight = yield* Ref.make<ReadonlyMap<string, InflightDelivery>>(new Map());
  // Sources whose control is being taken away. Marked before their in-flight
  // batch is interrupted so a batch racing into the queue behind it is refused
  // instead of winning the lock ahead of the cleanup.
  const closing = yield* Ref.make<ReadonlySet<string>>(new Set());
  const outcome = yield* Ref.make<ComputerCaptureOutcome>({
    lastCaptureAt: null,
    lastError: null,
  });
  const viewerSequence = yield* Ref.make(0);
  // One shared desktop, one mutex: the lease, the backend's input, held state,
  // viewer membership, and capture reconciliation are all one ordered
  // transition. Nothing under it may take it again.
  const hostLock = yield* Semaphore.make(1);
  const nudges = yield* PubSub.sliding<void>(1);

  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    hostLock.withPermits(1)(effect);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const publishStatus = PubSub.publish(nudges, undefined).pipe(Effect.asVoid);

  const viewerList = Ref.get(viewers).pipe(Effect.map((map) => [...map.values()]));

  const toViewerSource = (
    record: ViewerRecord,
  ): Extract<ComputerInputSource, { kind: "viewer" }> => ({
    kind: "viewer",
    viewerId: record.viewerId,
    sessionId: record.sessionId,
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
          controlling: heldBy(current, toViewerSource(record)),
        }),
      { discard: true },
    );
  });

  // ------------------------------------------------------------- held state

  /** Notes that this source is about to touch this display, before anything is
      sent. What comes back from an interrupted batch is unknowable, so the
      display counts as uncertain until the batch settles. */
  const touchHoldLocked = (source: ComputerInputSource, displayId: OpenbotComputerDisplayId) =>
    Ref.update(held, (map) => {
      const key = sourceKey(source);
      const record = map.get(key);
      const displays = new Map(record?.displays ?? []);
      displays.set(displayId, {
        state: displays.get(displayId)?.state ?? emptyComputerInputState,
        uncertain: true,
      });
      return new Map(map).set(key, { source, displays });
    });

  /** Folds what the backend accepted into the source's held state, which the
      session can now name again. */
  const settleHoldLocked = (
    source: ComputerInputSource,
    displayId: OpenbotComputerDisplayId,
    delivered: ReadonlyArray<OpenbotComputerInputEvent>,
  ) =>
    Ref.update(held, (map) => {
      const key = sourceKey(source);
      const record = map.get(key);
      const displays = new Map(record?.displays ?? []);
      const previous = displays.get(displayId)?.state ?? emptyComputerInputState;
      displays.set(displayId, {
        state: applyComputerInputEvents(previous, delivered),
        uncertain: false,
      });
      return new Map(map).set(key, { source, displays });
    });

  const releaseHoldLocked = (displayId: OpenbotComputerDisplayId, hold: DisplayHold) => {
    const events = hold.uncertain ? [RELEASE_ALL] : releaseEventsFor(hold.state);
    // A backend that is already gone cannot leave a key stuck either.
    return events.length === 0
      ? Effect.void
      : backend.input(displayId, events).pipe(Effect.ignore, Effect.asVoid);
  };

  /** Puts back everything these connections are holding, on every display they
      touched, and forgets it. */
  const releaseHoldsLocked = (keys: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const removed = yield* Ref.modify(held, (map) => {
        const next = new Map(map);
        const taken: Array<HeldRecord> = [];
        for (const key of keys) {
          const record = map.get(key);
          if (record === undefined) continue;
          next.delete(key);
          taken.push(record);
        }
        return [taken, next];
      });
      yield* Effect.forEach(
        removed.flatMap((record) => [...record.displays]),
        ([displayId, hold]) => releaseHoldLocked(displayId, hold),
        { discard: true },
      );
    });

  /** The same, for one display only: used when that display goes away and the
      rest of what a source holds elsewhere is still real. */
  const releaseDisplayHoldsLocked = (displayId: OpenbotComputerDisplayId) =>
    Effect.gen(function* () {
      const removed = yield* Ref.modify(held, (map) => {
        const next = new Map(map);
        const taken: Array<DisplayHold> = [];
        for (const [key, record] of map) {
          const hold = record.displays.get(displayId);
          if (hold === undefined) continue;
          const displays = new Map(record.displays);
          displays.delete(displayId);
          next.set(key, { source: record.source, displays });
          taken.push(hold);
        }
        return [taken, next];
      });
      yield* Effect.forEach(removed, (hold) => releaseHoldLocked(displayId, hold), {
        discard: true,
      });
    });

  /** Every connection that shares one lease: a person's frame socket and the
      RPC socket of the same browser session both answer to it. */
  const connectionsOfLease = (key: string) =>
    Effect.gen(function* () {
      const keys = new Set<string>();
      for (const [candidate, record] of yield* Ref.get(held)) {
        if (leaseKey(record.source) === key) keys.add(candidate);
      }
      for (const [candidate, delivery] of yield* Ref.get(inflight)) {
        if (leaseKey(delivery.source) === key) keys.add(candidate);
      }
      for (const record of yield* viewerList) {
        if (leaseKey(toViewerSource(record)) === key) keys.add(sourceKey(toViewerSource(record)));
      }
      return [...keys];
    });

  // ---------------------------------------------------------- cancellation

  /**
   * Takes control away from these connections and runs `cleanup` under the
   * host lock without queueing behind their work: they are marked so a batch
   * arriving now is refused, whatever they have in flight is interrupted, and
   * only then is the lock taken. That order is what makes "stop controlling"
   * prompt while a minute of text is being typed.
   */
  const withHostCancellation = <A, E, R>(
    keys: ReadonlyArray<string>,
    cleanup: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      yield* Ref.update(closing, (current) => new Set([...current, ...keys]));
      const cancelled = yield* Ref.modify(inflight, (map) => {
        const next = new Map(map);
        const taken: Array<InflightDelivery> = [];
        for (const key of keys) {
          const delivery = map.get(key);
          if (delivery === undefined) continue;
          next.delete(key);
          taken.push(delivery);
        }
        return [taken, next];
      });
      yield* Effect.forEach(cancelled, (delivery) => Fiber.interrupt(delivery.fiber), {
        discard: true,
      });
      return yield* locked(cleanup);
    }).pipe(
      Effect.ensuring(
        Ref.update(closing, (current) => {
          const next = new Set(current);
          for (const key of keys) next.delete(key);
          return next;
        }),
      ),
    );

  // ------------------------------------------------------------------ input

  /**
   * Hands one batch to the backend and folds what it accepted into the
   * source's held state for that display. Callers hold the host lock, which is
   * what makes batches land whole, in order, and only while their sender still
   * has the right to send them.
   */
  const deliverLocked = (
    source: ComputerInputSource,
    displayId: OpenbotComputerDisplayId,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
  ) =>
    Effect.gen(function* () {
      const coalesced = coalesceComputerInputMoves(events);
      yield* touchHoldLocked(source, displayId);
      const result = yield* backend.input(displayId, coalesced.events);
      const rejectedIndices = new Set(result.rejected.map((rejection) => rejection.index));
      const delivered = coalesced.events.filter((_, index) => !rejectedIndices.has(index));
      // The batch landed, so what it left down is known again; an interrupt
      // between the backend answering and this fold would only make the
      // display uncertain, which errs toward releasing too much.
      yield* Effect.uninterruptible(settleHoldLocked(source, displayId, delivered));
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

  /**
   * Runs one batch on its own fiber so it can be interrupted, and reports a
   * cancelled batch as rejected rather than leaving its sender waiting. The
   * fiber is registered under the sending connection, which is what
   * `withHostCancellation` reaches for.
   */
  const deliverCancellable = (
    source: ComputerInputSource,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
    work: Effect.Effect<OpenbotComputerInputResult, OpenbotComputerError>,
  ): Effect.Effect<OpenbotComputerInputResult, OpenbotComputerError> =>
    Effect.gen(function* () {
      const key = sourceKey(source);
      const fiber = yield* Effect.forkChild(work);
      yield* Ref.update(inflight, (map) => new Map(map).set(key, { source, fiber }));
      const exit = yield* Fiber.await(fiber).pipe(
        Effect.ensuring(
          Ref.update(inflight, (map) => {
            if (map.get(key)?.fiber !== fiber) return map;
            const next = new Map(map);
            next.delete(key);
            return next;
          }),
        ),
      );
      if (Exit.hasInterrupts(exit)) return rejectEvery(events, INPUT_CANCELLED_REASON);
      return yield* exit;
    });

  /** Recheck at the moment of delivery: a plan made before the lock was held
      is only a guess about who is controlling and where they are looking. */
  const planFor = (
    source: ComputerInputSource,
    target: OpenbotComputerDisplayId | null,
    viewerId: string | null,
  ): Effect.Effect<DeliveryPlan, OpenbotComputerError> =>
    Effect.gen(function* () {
      if ((yield* Ref.get(closing)).has(sourceKey(source))) {
        return { kind: "reject", reason: NOT_CONTROLLING_REASON };
      }
      const records = yield* Ref.get(viewers);
      // The frame socket aims at whatever display it currently shows; an RPC
      // batch names its own, and is stale if the person's own view has since
      // moved somewhere else.
      const own = viewerId === null ? undefined : records.get(viewerId);
      if (viewerId !== null && own === undefined) {
        return { kind: "reject", reason: NOT_CONTROLLING_REASON };
      }
      const displayId = target ?? own?.displayId ?? null;
      if (displayId === null) {
        return yield* new OpenbotComputerError({
          code: "display_not_found",
          message: "Open a display before sending input.",
        });
      }
      if (own !== undefined && own.displayId !== displayId) {
        return { kind: "reject", reason: DISPLAY_CHANGED_REASON };
      }
      if (own === undefined && source.kind === "viewer") {
        const watching = [...records.values()].filter(
          (record) => leaseKey(toViewerSource(record)) === leaseKey(source),
        );
        if (watching.length > 0 && !watching.some((record) => record.displayId === displayId)) {
          return { kind: "reject", reason: DISPLAY_CHANGED_REASON };
        }
      }
      if (!heldBy(yield* Ref.get(lease), source)) {
        return { kind: "reject", reason: NOT_CONTROLLING_REASON };
      }
      return { kind: "deliver", displayId };
    });

  const deliverPlanned = (
    source: ComputerInputSource,
    events: ReadonlyArray<OpenbotComputerInputEvent>,
    plan: Effect.Effect<DeliveryPlan, OpenbotComputerError>,
  ) =>
    deliverCancellable(
      source,
      events,
      locked(
        Effect.gen(function* () {
          const decided = yield* plan;
          return decided.kind === "reject"
            ? rejectEvery(events, decided.reason)
            : yield* deliverLocked(source, decided.displayId, events);
        }),
      ),
    );

  // ------------------------------------------------------------------ lease

  const takeLeaseLocked = (source: ComputerInputSource) =>
    Effect.gen(function* () {
      const since = yield* nowIso;
      const taken = yield* Ref.modify(lease, (current) => {
        const owner = sourceKey(source);
        if (current === null)
          return [null, { source, key: leaseKey(source), ownerConnection: owner, since }];
        // The same person on another of their connections: hand ownership to
        // whichever one is driving now, so that connection's disconnect is
        // what ends control. Nothing anyone is holding moves with it, and the
        // clock keeps running from when they first took it.
        if (current.key === leaseKey(source))
          return [null, { ...current, source, ownerConnection: owner }];
        return [current.source.label, current];
      });
      if (taken !== null) return yield* notControlling(taken);
      yield* broadcastController;
      yield* publishStatus;
    });

  /** Puts the desktop back before the lease is free, so the next controller
      never inherits a held button. */
  const releaseLeaseLocked = (source: ComputerInputSource) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(lease);
      if (current === null || !heldBy(current, source)) return;
      yield* releaseHoldsLocked(yield* connectionsOfLease(current.key));
      yield* Ref.set(lease, null);
      yield* broadcastController;
      yield* publishStatus;
    });

  /** Gives the lease back promptly: whatever the controller has in flight is
      interrupted first, so this does not wait out a long batch. Asking to stop
      is authorization, not ownership: Stop from either socket of the
      controlling session ends control, whichever of them took it. */
  const releaseControlFor = (source: ComputerInputSource) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(lease);
      const keys =
        current !== null && heldBy(current, source)
          ? yield* connectionsOfLease(current.key)
          : [sourceKey(source)];
      return yield* withHostCancellation(keys, releaseLeaseLocked(source));
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

  /** Detaches every viewer of a display that is no longer capturable, puts back
      what anyone left down on it, and frees a lease that was pointed there.
      Callers hold the host lock. */
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
      const holders = [...(yield* Ref.get(held))].flatMap(([, record]) =>
        record.displays.has(displayId) ? [record.source] : [],
      );
      // Sent even though the display is going: a host that tracks modifiers
      // globally still has them down after the screen it was aimed at leaves.
      yield* releaseDisplayHoldsLocked(displayId);
      const current = yield* Ref.get(lease);
      // Only the controlling connection's own screen leaving ends control. A
      // second connection of the same session losing its display is not that
      // person letting go of the desktop they are still driving elsewhere.
      if (
        current !== null &&
        (holders.some((source) => ownedByConnection(current, sourceKey(source))) ||
          affected.some((record) => ownedByConnection(current, sourceKey(toViewerSource(record)))))
      ) {
        yield* releaseLeaseLocked(current.source);
      }
    });

  /** Whoever is delivering to a display that is about to disappear, plus its
      viewers, so a vanishing display does not wait out a long batch either. */
  const connectionsOnDisplay = (displayId: OpenbotComputerDisplayId) =>
    Effect.gen(function* () {
      const keys = new Set<string>();
      const holds = yield* Ref.get(held);
      const current = yield* Ref.get(lease);
      for (const [key, delivery] of yield* Ref.get(inflight)) {
        if (
          holds.get(key)?.displays.has(displayId) === true ||
          leaseKey(delivery.source) === current?.key
        ) {
          keys.add(key);
        }
      }
      for (const record of yield* viewerList) {
        if (record.displayId === displayId) keys.add(sourceKey(toViewerSource(record)));
      }
      return [...keys];
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
    Effect.gen(function* () {
      const keys = yield* connectionsOnDisplay(displayId);
      yield* withHostCancellation(
        keys,
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
    });

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
      const latest = yield* Ref.make<ComputerFrame | null>(null);
      yield* Ref.update(captures, (map) => new Map(map).set(displayId, { profile, scope, latest }));
      yield* started.frames.pipe(
        Stream.runForEach((frame) =>
          recordFrameCaptured(frame.capturedAtMs).pipe(
            Effect.andThen(Ref.set(latest, frame)),
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
      none at all when nobody is watching. Callers hold the host lock. */
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
        Effect.gen(function* () {
          const keys = yield* connectionsOnDisplay(displayId);
          yield* withHostCancellation(
            keys,
            Effect.gen(function* () {
              yield* abandonDisplayLocked(displayId, "display-gone", "This display was destroyed.");
              yield* stopCaptureLocked(displayId);
            }),
          );
        }),
      ),
      Effect.andThen(publishStatus),
    );

  // ---------------------------------------------------------------- viewers

  /**
   * A closing connection takes only its own work away. When it is the one that
   * took the lease, that is the person letting go, so control ends and every
   * connection of theirs is cancelled and released with it; when it is another
   * connection of the same session, only its own in-flight batch is
   * interrupted and only its own holds come back up, leaving the controller's
   * lease and whatever it has mid-flight untouched.
   */
  const detachKeys = (key: string) =>
    Effect.gen(function* () {
      const before = yield* Ref.get(lease);
      return before !== null && before.ownerConnection === key
        ? yield* connectionsOfLease(before.key)
        : [key];
    });

  /** The lease and held-key half of a disconnect, under the host lock. */
  const detachConnectionLocked = (key: string, source: ComputerInputSource) =>
    Effect.gen(function* () {
      // Rechecked under the lock: ownership can have moved to another of this
      // person's connections since the keys were chosen.
      if (ownedByConnection(yield* Ref.get(lease), key)) {
        yield* releaseLeaseLocked(source);
      }
      yield* releaseHoldsLocked([key]);
    });

  const detachViewer = (viewerId: string) =>
    Effect.gen(function* () {
      const key = `viewer:${viewerId}`;
      yield* withHostCancellation(
        yield* detachKeys(key),
        Effect.gen(function* () {
          const removed = yield* Ref.modify(viewers, (map) => {
            const record = map.get(viewerId);
            if (record === undefined) return [null, map];
            const next = new Map(map);
            next.delete(viewerId);
            return [record, next];
          });
          if (removed === null) return;
          yield* detachConnectionLocked(key, toViewerSource(removed));
          if (removed.displayId !== null) yield* reconcileCaptureLocked(removed.displayId);
          yield* Queue.end(removed.control);
          yield* Queue.end(removed.frames);
        }),
      );
    });

  /**
   * The same disconnect for a source with no viewer record: the typed RPC
   * socket holds a lease and can leave keys down without ever attaching to a
   * display, and the held and in-flight maps are keyed by connection, so they
   * answer for it too.
   */
  const detachSource: OpenbotComputerSessionShape["detachSource"] = (source) =>
    Effect.gen(function* () {
      const key = sourceKey(source);
      yield* withHostCancellation(yield* detachKeys(key), detachConnectionLocked(key, source));
    });

  const attachViewer: OpenbotComputerSessionShape["attachViewer"] = (input) =>
    Effect.gen(function* () {
      const sequence = yield* Ref.updateAndGet(viewerSequence, (current) => current + 1);
      const viewerId = `viewer-${sequence}`;
      const control = yield* Queue.make<OpenbotComputerStreamServerMessage, Cause.Done>();
      const frames = yield* Queue.sliding<ComputerFrame, Cause.Done>(VIEWER_FRAME_BUFFER);
      const record: ViewerRecord = {
        viewerId,
        sessionId: input.sessionId,
        label: input.label,
        canControl: input.canControl,
        displayId: null,
        profile: { maxWidthPx: 0, fps: 0, quality: 0 },
        control,
        frames,
      };
      yield* locked(Ref.update(viewers, (map) => new Map(map).set(viewerId, record)));
      yield* Effect.addFinalizer(() => detachViewer(viewerId));
      const source: Extract<ComputerInputSource, { kind: "viewer" }> = {
        kind: "viewer",
        viewerId,
        sessionId: input.sessionId,
        label: input.label,
      };

      /**
       * Switching displays is the same transition as input, so it takes the
       * same lock and stops whatever this viewer had in flight first: half a
       * drag must not land on the screen it is leaving. The lease belongs to
       * the person, not the screen, so it survives the move.
       */
      const open: ComputerViewer["open"] = (displayId, profile) =>
        Effect.gen(function* () {
          const display = yield* findDisplay(displayId);
          const wanted = toCaptureProfile(profile);
          yield* withHostCancellation(
            [sourceKey(source)],
            Effect.gen(function* () {
              const previous = yield* Ref.modify(viewers, (map) => {
                const current = map.get(viewerId);
                if (current === undefined) return [undefined, map];
                return [
                  current.displayId,
                  new Map(map).set(viewerId, { ...current, displayId, profile: wanted }),
                ];
              });
              if (previous === undefined) return;
              if (previous !== null && previous !== displayId) {
                yield* releaseHoldsLocked([sourceKey(source)]);
              }
              // Frames already queued show the old display; the client sizes
              // its canvas from the message below, so none of them may arrive
              // after it.
              yield* Queue.clear(frames);
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
              if (previous !== null && previous !== displayId) {
                yield* reconcileCaptureLocked(previous);
              }
              yield* reconcileCaptureLocked(displayId);
              // The backend drops idle frames, so joining a capture that is
              // already running would show nothing until the desktop moved.
              // Only the record now under `displayId` is consulted, which is
              // either the capture this viewer just joined or one started a
              // moment ago with an empty slot, so the seed is always the
              // current picture of the display it just bound to. The sliding
              // frame queue bounds it, and a fanout racing this seed costs at
              // most a duplicate of the frame already on screen.
              const capture = (yield* Ref.get(captures)).get(displayId);
              if (capture !== undefined) {
                const seed = yield* Ref.get(capture.latest);
                if (seed !== null) yield* Queue.offer(frames, seed);
              }
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
        yield* locked(takeLeaseLocked(source));
      });

      const viewerStreamInput: ComputerViewer["input"] = (events) =>
        deliverPlanned(source, events, planFor(source, null, viewerId));

      return {
        viewerId,
        messages: Stream.merge(
          Stream.fromQueue(control),
          // A frame that was already queued for the display this viewer just
          // left is not this viewer's picture any more.
          Stream.fromQueue(frames).pipe(
            Stream.filterEffect((frame) =>
              Ref.get(viewers).pipe(
                Effect.map((map) => map.get(viewerId)?.displayId === frame.displayId),
              ),
            ),
          ),
        ),
        open,
        takeControl,
        releaseControl: releaseControlFor(source),
        input: viewerStreamInput,
      } satisfies ComputerViewer;
    });

  // ------------------------------------------------------------------ input

  const agentInput: OpenbotComputerSessionShape["agentInput"] = (source, displayId, events) =>
    deliverCancellable(
      source,
      events,
      // The lease is taken for the batch and dropped with it, so a human who
      // takes control between two agent calls simply wins the next one. The
      // release runs while the lock is still held, even when the batch was
      // interrupted, so nothing stays down.
      locked(
        Effect.gen(function* () {
          if ((yield* Ref.get(closing)).has(sourceKey(source))) {
            return rejectEvery(events, NOT_CONTROLLING_REASON);
          }
          yield* takeLeaseLocked(source);
          return yield* deliverLocked(source, displayId, events);
        }).pipe(Effect.ensuring(releaseLeaseLocked(source))),
      ),
    );

  const viewerRpcInput: OpenbotComputerSessionShape["viewerInput"] = (source, displayId, events) =>
    deliverPlanned(source, events, planFor(source, displayId, null));

  const control: OpenbotComputerSessionShape["control"] = (source, action) =>
    (action === "take" ? locked(takeLeaseLocked(source)) : releaseControlFor(source)).pipe(
      Effect.andThen(status),
    );

  /**
   * Raising a window and launching an app both move focus on the one shared
   * desktop, so they answer to the lease exactly as input does: allowed for
   * whoever holds it, and for an agent when it is free by borrowing it for the
   * length of the call. A person's frame socket and their RPC socket share one
   * lease, which is what lets the window picker work while they control.
   */
  const withControlAuthority = <A>(
    source: ComputerInputSource,
    action: Effect.Effect<A, OpenbotComputerError>,
  ): Effect.Effect<A, OpenbotComputerError> =>
    locked(
      Effect.gen(function* () {
        const current = yield* Ref.get(lease);
        if (current !== null) {
          if (!heldBy(current, source)) return yield* notControlling(current.source.label);
          return yield* action;
        }
        if (source.kind === "viewer") return yield* action;
        return yield* takeLeaseLocked(source).pipe(
          Effect.andThen(action),
          Effect.ensuring(releaseLeaseLocked(source)),
        );
      }),
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
    focusWindow: (source, id) => withControlAuthority(source, backend.focusWindow(id)),
    snapshot,
    attachViewer,
    agentInput,
    viewerInput: viewerRpcInput,
    control,
    detachSource,
    controller: Ref.get(lease).pipe(Effect.map(controllerOf)),
    createDisplay,
    destroyDisplay,
    launch: (source, input) => withControlAuthority(source, backend.launch(input)),
  });
});

export const layer = Layer.effect(OpenbotComputerSession, make);
