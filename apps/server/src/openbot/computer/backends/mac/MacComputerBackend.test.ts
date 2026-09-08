import { OpenbotComputerDisplayId, OpenbotComputerWindowId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
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
const WINDOW_ID = OpenbotComputerWindowId.make("w-1");

const HELPER_APP = "/Applications/T3ComputerHelper.app";

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
  readonly reply?: (command: HelperCommandWithoutId) => HelperRecord;
  readonly binaryFailure?: ComputerHelperNotFound;
  /** Commands the fake helper never answers, so a test can interrupt one the
      way the session does when control is dropped mid-batch. */
  readonly stall?: (command: HelperCommandWithoutId) => boolean;
}) =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<HelperCommandWithoutId>();
    const frames = yield* PubSub.unbounded<HelperFrame>();
    const hello =
      options.hello ?? helloWith({ screenCapture: "granted", accessibility: "granted" });
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
        hello: helloWith({ screenCapture: "granted", accessibility: "denied" }),
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
