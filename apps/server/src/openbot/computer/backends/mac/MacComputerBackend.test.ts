import {
  OpenbotComputerDisplayId,
  OpenbotComputerWindowId,
  type OpenbotComputerError,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ComputerBackend } from "../../ComputerBackend.ts";
import { ComputerHelperBinary, ComputerHelperNotFound } from "./ComputerHelperBinary.ts";
import {
  ComputerHelperClient,
  type HelperCommandWithoutId,
  type HelperFrame,
  type HelperHelloRecord,
} from "./ComputerHelperClient.ts";
import type { HelperPermissions, HelperRecord } from "./ComputerHelperProtocol.ts";
import { layer as macComputerBackendLayer, macPermissionDetail } from "./MacComputerBackend.ts";

const DISPLAY_ID = OpenbotComputerDisplayId.make("37");
const OTHER_DISPLAY_ID = OpenbotComputerDisplayId.make("38");
/** A display the backend has never listed, standing in for one just unplugged. */
const UNKNOWN_DISPLAY_ID = OpenbotComputerDisplayId.make("999999");
const WINDOW_ID = OpenbotComputerWindowId.make("w-1");

const HELPER_APP = "/Applications/T3ComputerHelper.app";

const GRANTED: HelperPermissions = { screenCapture: "granted", accessibility: "granted" };
const DENIED: HelperPermissions = { screenCapture: "denied", accessibility: "denied" };
/** Screen Recording kept, Accessibility taken away in System Settings. */
const ACCESSIBILITY_REVOKED: HelperPermissions = {
  screenCapture: "granted",
  accessibility: "denied",
};

function helloWith(permissions: HelperPermissions): HelperHelloRecord {
  return {
    id: 1,
    type: "hello",
    protocolVersion: 1,
    pid: 4242,
    bundleId: "codes.t3.ComputerHelper",
    permissions,
    displays: [],
  };
}

interface HelperStub {
  /** Every command the backend sent, in order. */
  readonly sent: Queue.Queue<HelperCommandWithoutId>;
  readonly frames: PubSub.PubSub<HelperFrame>;
  readonly layer: Layer.Layer<ComputerBackend>;
}

/**
 * Substitutes the helper client port, so the backend under test is the real
 * one: its projections, its reply checks, and its capture bracketing.
 */
const makeStub = (options: {
  readonly hello?: HelperHelloRecord;
  /** What the helper grants right now, read afresh on every describe the way
      the client reads it from the helper. */
  readonly permissions?: Effect.Effect<HelperPermissions, OpenbotComputerError>;
  readonly reply?: (command: HelperCommandWithoutId) => HelperRecord;
  readonly binaryFailure?: ComputerHelperNotFound;
  /** Commands the fake helper never answers, so a test can interrupt one the
      way the session does when control is dropped mid-batch. */
  readonly stall?: (command: HelperCommandWithoutId) => boolean;
}) =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<HelperCommandWithoutId>();
    const frames = yield* PubSub.unbounded<HelperFrame>();
    const hello = options.hello ?? helloWith(GRANTED);
    const permissions = options.permissions ?? Effect.succeed(GRANTED);
    const reply = options.reply ?? ((): HelperRecord => ({ id: 1, type: "ok" }));

    const client = Layer.succeed(
      ComputerHelperClient,
      ComputerHelperClient.of({
        request: (command) =>
          Queue.offer(sent, command).pipe(
            Effect.andThen(
              options.stall?.(command) === true ? Effect.never : Effect.succeed(reply(command)),
            ),
          ),
        requestFrame: (command) =>
          Queue.offer(sent, command).pipe(
            Effect.as({
              displayId: String(DISPLAY_ID),
              widthPx: 4,
              heightPx: 2,
              capturedAtMs: 10,
              jpeg: new Uint8Array([1, 2, 3]),
            }),
          ),
        frames: Stream.fromPubSub(frames),
        events: Stream.empty,
        hello: Effect.succeed(hello),
        permissions,
      }),
    );
    const binary = Layer.succeed(
      ComputerHelperBinary,
      ComputerHelperBinary.of({
        resolve:
          options.binaryFailure === undefined
            ? Effect.succeed({ appPath: HELPER_APP, executablePath: `${HELPER_APP}/x` })
            : Effect.fail(options.binaryFailure),
      }),
    );
    return {
      sent,
      frames,
      layer: macComputerBackendLayer.pipe(Layer.provide(client), Layer.provide(binary)),
    } satisfies HelperStub;
  });

describe("macPermissionDetail", () => {
  it("names only the grants the user still owes", () => {
    expect(macPermissionDetail({ screenCapture: "granted", accessibility: "granted" })).toBeNull();
    expect(macPermissionDetail({ screenCapture: "denied", accessibility: "granted" })).toBe(
      "Grant Screen Recording to T3 Computer Helper in System Settings › Privacy & Security, then retry.",
    );
    expect(macPermissionDetail({ screenCapture: "granted", accessibility: "denied" })).toBe(
      "Grant Accessibility to T3 Computer Helper in System Settings › Privacy & Security, then retry.",
    );
    expect(macPermissionDetail({ screenCapture: "denied", accessibility: "unknown" })).toBe(
      "Grant Screen Recording and Accessibility to T3 Computer Helper in System Settings › Privacy & Security, then retry.",
    );
  });
});

describe("MacComputerBackend", () => {
  it.effect("reports the helper's permissions verbatim with a fix for the missing ones", () =>
    Effect.gen(function* () {
      const stub = yield* makeStub({
        permissions: Effect.succeed({ screenCapture: "granted", accessibility: "denied" }),
      });

      const description = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        return yield* backend.describe;
      }).pipe(Effect.provide(stub.layer));

      expect(description.session).toBe("signed-in-desktop");
      expect(description.setup).toBeNull();
      expect(description.unavailableReason).toBeNull();
      expect(description.permissions).toEqual({
        screenCapture: "granted",
        accessibility: "denied",
        detail:
          "Grant Accessibility to T3 Computer Helper in System Settings › Privacy & Security, then retry.",
      });
      expect(description.capabilities).toEqual({
        stream: true,
        input: true,
        windows: true,
        focusWindow: true,
        managedDisplays: true,
        launchApp: true,
      });
    }),
  );

  /**
   * The bug this guards: the helper connects before the user has granted
   * anything, and describing the computer used to answer from that handshake
   * forever, so the app still said "denied" after the grant landed.
   */
  it.effect("reports permissions granted after they were denied at connect", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(DENIED);
      const reads = yield* Ref.make(0);
      const stub = yield* makeStub({
        // The helper connected before either grant existed, and stays connected.
        hello: helloWith(DENIED),
        permissions: Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(Ref.get(current))),
      });

      const { before, after } = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        const before = yield* backend.describe;
        // The user grants both in System Settings; the live helper now reads
        // them as granted and says so.
        yield* Ref.set(current, GRANTED);
        return { before, after: yield* backend.describe };
      }).pipe(Effect.provide(stub.layer));

      expect(before.permissions).toEqual({
        screenCapture: "denied",
        accessibility: "denied",
        detail:
          "Grant Screen Recording and Accessibility to T3 Computer Helper in System Settings › Privacy & Security, then retry.",
      });
      expect(after.permissions).toEqual({
        screenCapture: "granted",
        accessibility: "granted",
        detail: null,
      });
      // Both describes asked what is granted now. A describe that re-read the
      // handshake would leave this at zero and still report denied.
      expect(yield* Ref.get(reads)).toBe(2);
    }),
  );

  it.effect("reports a revoked permission", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(GRANTED);
      const stub = yield* makeStub({ hello: helloWith(GRANTED), permissions: Ref.get(current) });

      const { before, after } = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        const before = yield* backend.describe;
        yield* Ref.set(current, ACCESSIBILITY_REVOKED);
        return { before, after: yield* backend.describe };
      }).pipe(Effect.provide(stub.layer));

      expect(before.permissions.detail).toBeNull();
      expect(after.permissions).toEqual({
        screenCapture: "granted",
        accessibility: "denied",
        detail:
          "Grant Accessibility to T3 Computer Helper in System Settings › Privacy & Security, then retry.",
      });
    }),
  );

  it.effect("turns a missing helper bundle into an actionable setup list", () =>
    Effect.gen(function* () {
      const notFound = new ComputerHelperNotFound({ candidates: ["/nope"] });
      const stub = yield* makeStub({ binaryFailure: notFound });

      const description = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        return yield* backend.describe;
      }).pipe(Effect.provide(stub.layer));

      expect(description.unavailableReason).toBe(notFound.message);
      expect(description.setup).toEqual({
        ready: false,
        dependencies: [
          {
            name: "T3 Computer Helper",
            present: false,
            path: null,
            install: "pnpm build:computer-helper",
          },
        ],
        notes: [notFound.message],
      });
      expect(description.permissions.detail).toBeNull();
    }),
  );

  it.effect("projects the helper's displays and windows onto the contract", () =>
    Effect.gen(function* () {
      const stub = yield* makeStub({
        reply: (command) =>
          command.type === "displays"
            ? {
                id: 1,
                type: "displays",
                displays: [
                  {
                    id: DISPLAY_ID,
                    name: "Built-in Retina Display",
                    kind: "physical",
                    widthPx: 3024,
                    heightPx: 1964,
                    scale: 2,
                    main: true,
                    managed: false,
                  },
                ],
              }
            : {
                id: 2,
                type: "windows",
                windows: [
                  {
                    id: WINDOW_ID,
                    displayId: null,
                    title: "Off-screen",
                    app: "Finder",
                    pid: 12,
                    x: -100,
                    y: 0,
                    width: 10,
                    height: 20,
                    focused: false,
                    minimized: true,
                  },
                ],
              },
      });

      const { displays, windows } = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        return {
          displays: yield* backend.listDisplays,
          windows: yield* backend.listWindows,
        };
      }).pipe(Effect.provide(stub.layer));

      expect(displays).toEqual([
        {
          id: DISPLAY_ID,
          name: "Built-in Retina Display",
          kind: "physical",
          widthPx: 3024,
          heightPx: 1964,
          scale: 2,
          main: true,
          managed: false,
        },
      ]);
      expect(windows[0]?.id).toBe(WINDOW_ID);
      expect(windows[0]?.displayId).toBeNull();
    }),
  );

  it.effect("stops the capture when the caller's scope closes, and only shows its display", () =>
    Effect.gen(function* () {
      const stub = yield* makeStub({});

      const received = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* backend.capture(DISPLAY_ID, {
              maxWidthPx: 1280,
              fps: 10,
              quality: 0.7,
            });
            const collected = yield* Queue.unbounded<string>();
            yield* stream.pipe(
              Stream.runForEach((frame) => Queue.offer(collected, String(frame.displayId))),
              Effect.forkChild,
            );
            yield* Effect.forEach(
              Array.from({ length: 20 }, (_, index) => index),
              () => Effect.yieldNow,
            );

            yield* PubSub.publish(stub.frames, {
              displayId: String(OTHER_DISPLAY_ID),
              widthPx: 1,
              heightPx: 1,
              capturedAtMs: 1,
              jpeg: new Uint8Array([9]),
            });
            yield* PubSub.publish(stub.frames, {
              displayId: String(DISPLAY_ID),
              widthPx: 1,
              heightPx: 1,
              capturedAtMs: 2,
              jpeg: new Uint8Array([8]),
            });

            return yield* Queue.take(collected);
          }),
        );
      }).pipe(Effect.provide(stub.layer));

      expect(received).toBe(String(DISPLAY_ID));

      const commands = yield* Queue.takeAll(stub.sent);
      expect(commands.map((command) => command.type)).toEqual(["capture-start", "capture-stop"]);
    }),
  );

  /**
   * Interruption is the contract's cancel signal, but the helper is a separate
   * process typing at a fixed pace: it hears about it only if something tells
   * it, and `release-all` is what cancels the batch it is still delivering.
   */
  it.effect("tells the helper to release everything when the batch is interrupted", () =>
    Effect.gen(function* () {
      const stub = yield* makeStub({
        stall: (command) =>
          command.type === "input" && command.events.some((event) => event.type === "text"),
      });

      yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        const typing = yield* backend
          .input(DISPLAY_ID, [{ type: "text", text: "a".repeat(4096) }])
          .pipe(Effect.forkChild);

        const started = yield* Queue.take(stub.sent);
        expect(started.type).toBe("input");

        yield* Fiber.interrupt(typing);

        const cancelling = yield* Queue.take(stub.sent);
        expect(cancelling).toEqual({
          type: "input",
          displayId: DISPLAY_ID,
          events: [{ type: "release-all" }],
        });
      }).pipe(Effect.provide(stub.layer));
    }),
  );

  /**
   * Cleanup has to survive the display it names. A monitor unplugged mid-drag
   * leaves a button down, and the release for it arrives addressed to a display
   * that no longer exists: the backend must forward it rather than decide the
   * target is unknown, because the helper releases held input globally.
   */
  it.effect("forwards a release-all-only batch for a display it has never seen", () =>
    Effect.gen(function* () {
      const stub = yield* makeStub({
        reply: () => ({
          id: 1,
          type: "input-result",
          delivered: 1,
          rejected: [],
        }),
      });

      const result = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        return yield* backend.input(UNKNOWN_DISPLAY_ID, [{ type: "release-all" }]);
      }).pipe(Effect.provide(stub.layer));

      expect(result).toEqual({ delivered: 1, rejected: [] });
      const commands = yield* Queue.takeAll(stub.sent);
      expect(Array.from(commands)).toEqual([
        {
          type: "input",
          displayId: UNKNOWN_DISPLAY_ID,
          events: [{ type: "release-all" }],
        },
      ]);
    }),
  );

  it.effect("treats a reply of the wrong type as an unavailable backend", () =>
    Effect.gen(function* () {
      const stub = yield* makeStub({
        reply: () => ({ id: 1, type: "windows", windows: [] }),
      });

      const error = yield* Effect.gen(function* () {
        const backend = yield* ComputerBackend;
        return yield* backend.focusWindow(WINDOW_ID);
      }).pipe(Effect.flip, Effect.provide(stub.layer));

      expect(error.code).toBe("backend_unavailable");
      expect(error.message).toBe("helper replied with 'windows' to 'focus-window'");
    }),
  );
});
