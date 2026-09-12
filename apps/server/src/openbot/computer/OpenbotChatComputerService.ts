import {
  OpenbotComputerError,
  type OpenbotChannel,
  type OpenbotChannelId,
  type OpenbotChatComputer,
  type OpenbotChatComputerState,
  type OpenbotComputerDisplay,
  type OpenbotComputerWindow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import { OpenbotChannelStore } from "../OpenbotChannelStore.ts";
import {
  OpenbotChatComputerService,
  type OpenbotChatComputerShape,
} from "./OpenbotChatComputer.ts";
import { OpenbotComputerSession } from "./OpenbotComputerSession.ts";

/**
 * One managed display per top-level chat, created on first use and remembered
 * for the life of the process.
 *
 * Everything here is a decision about *which* display a chat means; the lease,
 * ordering, capture, and cleanup all still belong to `OpenbotComputerSession`.
 * Nothing in this file ever picks the main display or any other physical
 * screen: a chat that has no managed display of its own has no computer, and
 * saying so is better than quietly driving the person's own monitor.
 */

/** The chat's screen. Large enough for a browser and an editor side by side,
    small enough to encode at a readable frame rate over a remote link. */
const CHAT_DISPLAY_WIDTH_PX = 1680;
const CHAT_DISPLAY_HEIGHT_PX = 1050;

/** The app macOS attaches the grants to, whatever launched the server. */
const HELPER_NAME = "T3 Computer Helper";

/**
 * Why a launch is refused rather than attempted. Without Accessibility macOS
 * cannot place a new window on a specific display, and the app would open on
 * the screen the person is using — the one outcome this feature exists to
 * avoid — so the launch never reaches the host.
 */
export const LAUNCH_ACCESSIBILITY_DETAIL = `Opening an app on this chat's computer needs Accessibility. Grant it to ${HELPER_NAME} (codes.t3.openbot.computer-helper) in System Settings › Privacy & Security › Accessibility, then try again. Until then nothing is launched: without that grant macOS would put the window on your own screen instead of the chat's.`;

/** Said when a chat's parent chain is not the one level the schema promises. */
const INCONSISTENT_CHAIN = "chat nesting is one level; data is inconsistent";

/**
 * What this server knows about one chat's display right now.
 *
 * `provisioning` carries the creation in flight so a second caller waits on it
 * instead of asking the host for a second screen, and `unavailable` keeps the
 * last failure so `get` can explain an empty rail without provisioning
 * anything.
 */
type ChatDisplayEntry =
  | { readonly kind: "ready"; readonly display: OpenbotComputerDisplay }
  | {
      readonly kind: "provisioning";
      readonly pending: Deferred.Deferred<OpenbotComputerDisplay, OpenbotComputerError>;
    }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "released"; readonly display: OpenbotComputerDisplay | null };

/** What one pass of `acquire` decided to do, settled inside a single atomic
    read-modify-write so two callers cannot both decide to create. */
type AcquireDecision =
  | { readonly kind: "listed"; readonly display: OpenbotComputerDisplay }
  | {
      readonly kind: "await";
      readonly pending: Deferred.Deferred<OpenbotComputerDisplay, OpenbotComputerError>;
    }
  | { readonly kind: "create" }
  | { readonly kind: "released" };

/** What one pass of `acquire` came back with: the chat's display, or a
    remembered display the host has since lost, which sends the caller round
    the loop for a fresh decision. */
type AcquirePass =
  | { readonly kind: "resolved"; readonly display: OpenbotComputerDisplay }
  | { readonly kind: "retry" };

/** The one sentence a person or an agent can read out of a failed creation. */
const detailOfCause = (cause: Cause.Cause<OpenbotComputerError>): string => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error ? squashed.message : String(squashed);
};

const invalidInput = (message: string) =>
  new OpenbotComputerError({ code: "invalid_input", message });

export const make = Effect.gen(function* () {
  const session = yield* OpenbotComputerSession;
  const store = yield* OpenbotChannelStore;

  const ownerLocks = yield* Ref.make<ReadonlyMap<OpenbotChannelId, Semaphore.Semaphore>>(new Map());
  const ownerLock = Effect.fn(function* (channelId: OpenbotChannelId) {
    const candidate = yield* Semaphore.make(1);
    return yield* Ref.modify(ownerLocks, (locks) => {
      const existing = locks.get(channelId);
      return existing === undefined
        ? ([candidate, new Map(locks).set(channelId, candidate)] as const)
        : ([existing, locks] as const);
    });
  });
  const entries = yield* Ref.make<ReadonlyMap<OpenbotChannelId, ChatDisplayEntry>>(new Map());
  /** Nudged whenever this server's own view of a chat's display moves, which
      the host's status stream cannot know about. */
  const changed = yield* PubSub.unbounded<OpenbotChannelId>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // A chat row that cannot be read is a broken database, not a computer
  // failure this API can describe; it fails fast rather than being dressed up
  // as an unavailable desktop.
  const requireChannel = Effect.fn("OpenbotChatComputerService.requireChannel")(function* (
    channelId: OpenbotChannelId,
  ) {
    const channel = yield* store.getById(channelId).pipe(Effect.orDie);
    if (channel === undefined) {
      return yield* invalidInput(`Chat ${channelId} was not found.`);
    }
    return channel;
  });

  /**
   * The top-level chat whose computer this one is. A child hands back its
   * parent; a chain that is deeper than one level, or that comes back to a
   * chat already on it, is reported rather than followed.
   */
  const ownerOf = Effect.fn("OpenbotChatComputerService.ownerOf")(function* (
    channel: OpenbotChannel,
  ) {
    if (channel.parentChannelId === null) return channel;
    const parent = yield* requireChannel(channel.parentChannelId);
    // A self-parent or a cycle lands here too: it comes back as a chat that
    // still has a parent of its own.
    if (parent.parentChannelId !== null) {
      return yield* invalidInput(
        `Chat ${channel.id} resolves through ${parent.id}, which has a parent of its own: ${INCONSISTENT_CHAIN}.`,
      );
    }
    return parent;
  });

  const ownerOfId = (channelId: OpenbotChannelId) =>
    requireChannel(channelId).pipe(Effect.flatMap(ownerOf));

  /** Only the windows the host puts on this chat's own screen. */
  const ownedWindows = (displayId: OpenbotComputerDisplay["id"]) =>
    session
      .listWindows(displayId)
      .pipe(Effect.map((windows) => windows.filter((window) => window.displayId === displayId)));

  /** Whether a launch could place its window on a managed display right now.
      macOS needs Accessibility for that; Linux places by session, not grant. */
  const launchable = session.status.pipe(
    Effect.map(
      (status) =>
        status.capabilities.launchApp &&
        (status.host.platform === "darwin" ? status.permissions.accessibility === "granted" : true),
    ),
  );

  const view = Effect.fn("OpenbotChatComputerService.view")(function* (
    owner: OpenbotChannel,
    described: {
      readonly state: OpenbotChatComputerState;
      readonly display: OpenbotComputerDisplay | null;
      readonly detail: string | null;
    },
  ) {
    const display = described.display;
    const windows: ReadonlyArray<OpenbotComputerWindow> =
      display === null ? [] : yield* ownedWindows(display.id).pipe(Effect.orElseSucceed(() => []));
    const controller = yield* session.controller;
    const canLaunch = yield* launchable;
    return {
      channelId: owner.id,
      channelName: owner.name,
      state: described.state,
      display,
      detail: described.detail,
      windows,
      controller,
      canLaunch,
      checkedAt: yield* nowIso,
    } satisfies OpenbotChatComputer;
  });

  const describeEntry = (owner: OpenbotChannel, entry: ChatDisplayEntry | undefined) => {
    if (entry === undefined) return view(owner, { state: "idle", display: null, detail: null });
    switch (entry.kind) {
      case "ready":
        return view(owner, { state: "ready", display: entry.display, detail: null });
      case "provisioning":
        return view(owner, { state: "provisioning", display: null, detail: null });
      case "released":
        return view(owner, {
          state: "unavailable",
          display: null,
          detail: "This chat’s computer was released.",
        });
      case "unavailable":
        return view(owner, { state: "unavailable", display: null, detail: entry.detail });
    }
  };

  const currentView = (owner: OpenbotChannel) =>
    Ref.get(entries).pipe(Effect.flatMap((map) => describeEntry(owner, map.get(owner.id))));

  /**
   * Provision-or-reuse, failing loudly so the acting paths (snapshot, focus,
   * launch, input) never act on a display that is not there. `ensure` is the
   * one caller that turns a failure into a description instead.
   *
   * Concurrency is settled by one `Ref.modify`: whoever installs the pending
   * `Deferred` creates, everyone else waits on it, so a UI mount racing an
   * agent's first tool call produces one display.
   */
  const acquireUnlocked = Effect.fn("OpenbotChatComputerService.acquire")(function* (
    owner: OpenbotChannel,
  ): Effect.fn.Return<OpenbotComputerDisplay, OpenbotComputerError> {
    for (;;) {
      // Outside the mask on purpose: a `Deferred` nobody has been told about
      // is not ownership, and dropping the fiber here costs nothing.
      const pending = yield* Deferred.make<OpenbotComputerDisplay, OpenbotComputerError>();

      // The mask is where ownership lives. The `Ref.modify` below is the
      // moment this fiber becomes the one every later caller waits on, and
      // from there the entry can only be settled by this fiber, so publishing
      // it and settling it are one committed unit. An interrupt anywhere in
      // between — a viewer socket closing before the host has even been asked
      // — would leave the map holding a `provisioning` whose `Deferred` nobody
      // completes, and park every later `ensure` and `acquire` on it for the
      // life of the process. Asking the host is inside that unit too: an
      // interrupt between the host's answer and the settlement would strand a
      // real display nobody owns, and an abandoned caller paying out the
      // one-second creation is the cheaper outcome by far.
      //
      // `restore` marks the two passes that own nothing and so must not make
      // an interrupt wait: a caller parked on somebody else's creation, and a
      // caller re-listing a display it only remembers. Neither has anything to
      // settle if it goes away.
      //
      // The entry, the change note, and the Deferred all carry this one
      // outcome, and the Deferred is completed last: waking a waiter first
      // would let it hand a display back to a client that a following `get`
      // still describes as `provisioning`. A failure leaves `unavailable`
      // rather than `provisioning`, which is what lets the next `ensure` take
      // the create branch again and retry.
      const pass = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const decision = yield* Ref.modify(
            entries,
            (map): readonly [AcquireDecision, ReadonlyMap<OpenbotChannelId, ChatDisplayEntry>] => {
              const entry = map.get(owner.id);
              if (entry?.kind === "released") return [{ kind: "released" }, map];
              if (entry?.kind === "ready") return [{ kind: "listed", display: entry.display }, map];
              if (entry?.kind === "provisioning")
                return [{ kind: "await", pending: entry.pending }, map];
              return [
                { kind: "create" },
                new Map(map).set(owner.id, { kind: "provisioning", pending }),
              ];
            },
          );

          if (decision.kind === "released")
            return yield* invalidInput("This chat’s computer was released.");

          if (decision.kind === "await") {
            const display = yield* restore(Deferred.await(decision.pending));
            return { kind: "resolved", display } satisfies AcquirePass;
          }

          if (decision.kind === "listed") {
            return yield* restore(
              Effect.gen(function* () {
                // Display ids are the host's, and a helper restart or a
                // signed-out session takes them with it. The listing is the
                // only evidence the remembered screen still exists, and it
                // refreshes its geometry.
                const listed = yield* session.listDisplays;
                const live = listed.find((display) => display.id === decision.display.id);
                if (live !== undefined) {
                  yield* Ref.update(entries, (map) => {
                    const entry = map.get(owner.id);
                    return entry?.kind === "ready" && entry.display.id === live.id
                      ? new Map(map).set(owner.id, { kind: "ready", display: live })
                      : map;
                  });
                  return { kind: "resolved", display: live } satisfies AcquirePass;
                }
                yield* Ref.update(entries, (map) => {
                  const entry = map.get(owner.id);
                  if (entry?.kind !== "ready" || entry.display.id !== decision.display.id)
                    return map;
                  const next = new Map(map);
                  next.delete(owner.id);
                  return next;
                });
                yield* PubSub.publish(changed, owner.id);
                return { kind: "retry" } satisfies AcquirePass;
              }),
            );
          }

          const exit = yield* Effect.exit(
            session.createDisplay({
              name: owner.name,
              widthPx: CHAT_DISPLAY_WIDTH_PX,
              heightPx: CHAT_DISPLAY_HEIGHT_PX,
              hiDpi: true,
            }),
          );
          const settled: ChatDisplayEntry = Exit.isSuccess(exit)
            ? { kind: "ready", display: exit.value }
            : { kind: "unavailable", detail: detailOfCause(exit.cause) };
          yield* Ref.update(entries, (map) => new Map(map).set(owner.id, settled));
          yield* PubSub.publish(changed, owner.id);
          yield* Deferred.done(pending, exit);
          if (Exit.isSuccess(exit)) {
            return { kind: "resolved", display: exit.value } satisfies AcquirePass;
          }
          return yield* Effect.failCause(exit.cause);
        }),
      );

      if (pass.kind === "resolved") return pass.display;
    }
  });

  const acquire = Effect.fn(function* (owner: OpenbotChannel) {
    const entry = (yield* Ref.get(entries)).get(owner.id);
    if (entry?.kind === "provisioning") return yield* Deferred.await(entry.pending);
    const lock = yield* ownerLock(owner.id);
    return yield* acquireUnlocked(owner).pipe(lock.withPermits(1));
  });

  const release: OpenbotChatComputerShape["release"] = Effect.fn(
    "OpenbotChatComputerService.release",
  )(function* (channelId) {
    const lock = yield* ownerLock(channelId);
    yield* Effect.gen(function* () {
      const entry = (yield* Ref.get(entries)).get(channelId);
      const display = entry?.kind === "ready" || entry?.kind === "released" ? entry.display : null;
      // Keep the display until destruction succeeds, so a failed request can
      // retry. The released state also blocks callers resolved before deletion.
      yield* Ref.update(entries, (map) =>
        new Map(map).set(channelId, { kind: "released", display }),
      );
      yield* PubSub.publish(changed, channelId);
      if (display !== null) {
        yield* session.destroyDisplay(display.id);
        yield* Ref.update(entries, (map) =>
          new Map(map).set(channelId, { kind: "released", display: null }),
        );
      }
    }).pipe(lock.withPermits(1), Effect.uninterruptible);
  });

  const get: OpenbotChatComputerShape["get"] = Effect.fn("OpenbotChatComputerService.get")(
    function* (channelId) {
      return yield* currentView(yield* ownerOfId(channelId));
    },
  );

  const ensure: OpenbotChatComputerShape["ensure"] = Effect.fn("OpenbotChatComputerService.ensure")(
    function* (channelId) {
      const owner = yield* ownerOfId(channelId);
      return yield* acquire(owner).pipe(
        Effect.flatMap((display) => view(owner, { state: "ready", display, detail: null })),
        // A host that cannot make a screen is a state to render, not an
        // exception: the rail says why instead of showing an error toast.
        Effect.catch((error) =>
          error.code === "invalid_input"
            ? Effect.fail(error)
            : view(owner, { state: "unavailable", display: null, detail: error.message }),
        ),
      );
    },
  );

  /** `checkedAt` moves on every recomposition, so it is left out of the
      comparison that decides whether a client learned anything new. */
  const sameView = (left: OpenbotChatComputer, right: OpenbotChatComputer) =>
    JSON.stringify({ ...left, checkedAt: "" }) === JSON.stringify({ ...right, checkedAt: "" });

  const changes: OpenbotChatComputerShape["changes"] = (channelId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const owner = yield* ownerOfId(channelId);
        // Subscribed before the first view is composed, so a change that lands
        // while it is being read still produces a follow-up.
        const local = yield* PubSub.subscribe(changed);
        const hostChanged = Stream.map(session.statusChanges, (): void => undefined);
        const ownChanged = Stream.fromSubscription(local).pipe(
          Stream.filter((id) => id === owner.id),
          Stream.map((): void => undefined),
        );
        // The host's own stream opens with the current status, which is what
        // makes the first element of this stream the current view.
        return Stream.mapEffect(Stream.merge(hostChanged, ownChanged), () => currentView(owner));
      }),
    ).pipe(
      Stream.changesWith(sameView),
      // The stream carries no error channel: a chat that cannot be resolved has
      // nothing to stream, and `get` is where a client learns why.
      Stream.catch(() => Stream.empty),
    );

  const channelForThread: OpenbotChatComputerShape["channelForThread"] = Effect.fn(
    "OpenbotChatComputerService.channelForThread",
  )(function* (threadId) {
    const channel = yield* store.getByThreadId(threadId).pipe(Effect.orDie);
    if (channel === undefined) {
      return yield* invalidInput(`No chat was found for thread ${threadId}.`);
    }
    return (yield* ownerOf(channel)).id;
  });

  const snapshot: OpenbotChatComputerShape["snapshot"] = Effect.fn(
    "OpenbotChatComputerService.snapshot",
  )(function* (channelId, maxWidthPx) {
    const display = yield* acquire(yield* ownerOfId(channelId));
    return yield* session.snapshot({
      displayId: display.id,
      ...(maxWidthPx === undefined ? {} : { maxWidthPx }),
    });
  });

  const focusWindow: OpenbotChatComputerShape["focusWindow"] = Effect.fn(
    "OpenbotChatComputerService.focusWindow",
  )(function* (source, channelId, windowId) {
    const owner = yield* ownerOfId(channelId);
    const display = yield* acquire(owner);
    const windows = yield* ownedWindows(display.id);
    if (!windows.some((window) => window.id === windowId)) {
      return yield* new OpenbotComputerError({
        code: "window_not_found",
        message: `Window ${windowId} is not on ${owner.name}'s computer.`,
      });
    }
    yield* session.focusWindow(source, windowId);
  });

  const launch: OpenbotChatComputerShape["launch"] = Effect.fn("OpenbotChatComputerService.launch")(
    function* (source, channelId, input) {
      const display = yield* acquire(yield* ownerOfId(channelId));
      if (!(yield* launchable)) {
        return yield* new OpenbotComputerError({
          code: "permission_denied",
          message: LAUNCH_ACCESSIBILITY_DETAIL,
        });
      }
      return yield* session.launch(source, {
        app: input.app,
        ...(input.args === undefined ? {} : { args: input.args }),
        displayId: display.id,
      });
    },
  );

  const input: OpenbotChatComputerShape["input"] = Effect.fn("OpenbotChatComputerService.input")(
    function* (source, channelId, events) {
      const display = yield* acquire(yield* ownerOfId(channelId));
      return yield* source.kind === "agent"
        ? session.agentInput(source, display.id, events)
        : session.viewerInput(source, display.id, events);
    },
  );

  return OpenbotChatComputerService.of({
    get,
    release,
    ensure,
    changes,
    channelForThread,
    snapshot,
    focusWindow,
    launch,
    input,
  });
});

export const layer = Layer.effect(OpenbotChatComputerService, make);
