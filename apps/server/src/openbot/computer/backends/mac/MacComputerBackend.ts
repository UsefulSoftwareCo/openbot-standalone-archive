import {
  OpenbotComputerError,
  type OpenbotComputerCapabilities,
  type OpenbotComputerDisplay,
  type OpenbotComputerDisplayId,
  type OpenbotComputerInputResult,
  type OpenbotComputerLaunchResult,
  type OpenbotComputerPermissions,
  type OpenbotComputerSetup,
  type OpenbotComputerWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  ComputerBackend,
  type ComputerBackendShape,
  type ComputerFrame,
} from "../../ComputerBackend.ts";
import { ComputerHelperBinary } from "./ComputerHelperBinary.ts";
import {
  ComputerHelperClient,
  type HelperCommandWithoutId,
  type HelperFrame,
} from "./ComputerHelperClient.ts";
import type {
  HelperDisplay,
  HelperPermissions,
  HelperRecord,
  HelperWindow,
} from "./ComputerHelperProtocol.ts";

/**
 * The macOS backend. Every platform mechanic lives in the helper app; this file
 * is the translation between the helper's records and the platform-neutral
 * contract the session layer and clients see.
 */

/** The helper implements every capability the contract knows about. Whether a
    capability currently *works* is a permission question, reported separately. */
const MAC_CAPABILITIES: OpenbotComputerCapabilities = {
  stream: true,
  input: true,
  windows: true,
  focusWindow: true,
  managedDisplays: true,
  launchApp: true,
};

const UNKNOWN_PERMISSIONS: OpenbotComputerPermissions = {
  screenCapture: "unknown",
  accessibility: "unknown",
  detail: null,
};

const HELPER_INSTALL_COMMAND = "pnpm build:computer-helper";

function backendUnavailable(message: string): OpenbotComputerError {
  return new OpenbotComputerError({ code: "backend_unavailable", message });
}

function wrongReply(record: HelperRecord, sent: string): OpenbotComputerError {
  return backendUnavailable(`helper replied with '${record.type}' to '${sent}'`);
}

/**
 * Names the grants the user still owes, in the words of the System Settings
 * pane they have to visit. Null when nothing is missing.
 */
export function macPermissionDetail(permissions: HelperPermissions): string | null {
  const missing: Array<string> = [];
  if (permissions.screenCapture !== "granted") missing.push("Screen Recording");
  if (permissions.accessibility !== "granted") missing.push("Accessibility");
  if (missing.length === 0) return null;
  return `Grant ${missing.join(" and ")} to T3 Computer Helper in System Settings › Privacy & Security, then retry.`;
}

function helperMissingSetup(note: string): OpenbotComputerSetup {
  return {
    ready: false,
    dependencies: [
      { name: "T3 Computer Helper", present: false, path: null, install: HELPER_INSTALL_COMMAND },
    ],
    notes: [note],
  };
}

/**
 * The helper's display and window records are parsed against branded contract
 * ids at the protocol boundary, and the helper's display kinds are a subset of
 * the contract's, so these are widening projections rather than re-parses.
 */
function toDisplay(display: HelperDisplay): OpenbotComputerDisplay {
  return display;
}

function toWindow(window: HelperWindow): OpenbotComputerWindow {
  return window;
}

function toComputerFrame(displayId: OpenbotComputerDisplayId, frame: HelperFrame): ComputerFrame {
  return {
    displayId,
    jpeg: frame.jpeg,
    widthPx: frame.widthPx,
    heightPx: frame.heightPx,
    capturedAtMs: frame.capturedAtMs,
  };
}

export const make = Effect.fn("openbot.computer.macComputerBackend.make")(function* () {
  const client = yield* ComputerHelperClient;
  const binary = yield* ComputerHelperBinary;

  const describe: ComputerBackendShape["describe"] = Effect.gen(function* () {
    const resolved = yield* Effect.result(binary.resolve);
    if (Result.isFailure(resolved)) {
      return {
        session: "signed-in-desktop" as const,
        permissions: UNKNOWN_PERMISSIONS,
        setup: helperMissingSetup(resolved.failure.message),
        capabilities: MAC_CAPABILITIES,
        unavailableReason: resolved.failure.message,
      };
    }
    const hello = yield* Effect.result(client.hello);
    if (Result.isFailure(hello)) {
      return {
        session: "signed-in-desktop" as const,
        permissions: UNKNOWN_PERMISSIONS,
        setup: null,
        capabilities: MAC_CAPABILITIES,
        unavailableReason: hello.failure.message,
      };
    }
    // The handshake record is a snapshot of the moment the helper connected, and
    // a user granting Screen Recording in System Settings does not reconnect it.
    // Describing the computer has to ask what is granted now.
    const permissions = yield* Effect.result(client.permissions);
    if (Result.isFailure(permissions)) {
      return {
        session: "signed-in-desktop" as const,
        permissions: UNKNOWN_PERMISSIONS,
        setup: null,
        capabilities: MAC_CAPABILITIES,
        unavailableReason: permissions.failure.message,
      };
    }
    return {
      session: "signed-in-desktop" as const,
      permissions: {
        screenCapture: permissions.success.screenCapture,
        accessibility: permissions.success.accessibility,
        detail: macPermissionDetail(permissions.success),
      },
      setup: null,
      capabilities: MAC_CAPABILITIES,
      unavailableReason: null,
    };
  });

  const listDisplays: ComputerBackendShape["listDisplays"] = client
    .request({ type: "displays" })
    .pipe(
      Effect.flatMap((record) =>
        record.type === "displays"
          ? Effect.succeed(record.displays.map(toDisplay))
          : Effect.fail(wrongReply(record, "displays")),
      ),
    );

  const listWindows: ComputerBackendShape["listWindows"] = client
    .request({ type: "windows" })
    .pipe(
      Effect.flatMap((record) =>
        record.type === "windows"
          ? Effect.succeed(record.windows.map(toWindow))
          : Effect.fail(wrongReply(record, "windows")),
      ),
    );

  /** Commands whose only successful answer is a bare acknowledgement. */
  const expectOk = (command: HelperCommandWithoutId) =>
    client
      .request(command)
      .pipe(
        Effect.flatMap((record) =>
          record.type === "ok" ? Effect.void : Effect.fail(wrongReply(record, command.type)),
        ),
      );

  const focusWindow: ComputerBackendShape["focusWindow"] = (id) =>
    expectOk({ type: "focus-window", windowId: id });

  const screenshot: ComputerBackendShape["screenshot"] = (displayId, maxWidthPx) =>
    client
      .requestFrame({ type: "screenshot", displayId, maxWidthPx })
      .pipe(Effect.map((frame) => toComputerFrame(displayId, frame)));

  const input: ComputerBackendShape["input"] = (displayId, events) =>
    client.request({ type: "input", displayId, events }).pipe(
      Effect.flatMap((record) =>
        record.type === "input-result"
          ? Effect.succeed({
              delivered: record.delivered,
              rejected: record.rejected,
            } satisfies OpenbotComputerInputResult)
          : Effect.fail(wrongReply(record, "input")),
      ),
      // Interruption is the cancel signal, and the helper hears about it only
      // through a command: `release-all` cancels the batch it is still
      // delivering, which for a long `text` event is the difference between
      // stopping now and typing for another two minutes. The session sends one
      // of these too when control is dropped; asking twice releases nothing
      // that was not already released.
      Effect.onInterrupt(() =>
        Effect.ignore(
          client.request({ type: "input", displayId, events: [{ type: "release-all" }] }),
        ),
      ),
    );

  const createDisplay: ComputerBackendShape["createDisplay"] = (create) =>
    client
      .request({
        type: "create-display",
        name: create.name ?? null,
        widthPx: create.widthPx,
        heightPx: create.heightPx,
        hiDpi: create.hiDpi ?? false,
      })
      .pipe(
        Effect.flatMap((record) =>
          record.type === "display"
            ? Effect.succeed(toDisplay(record.display))
            : Effect.fail(wrongReply(record, "create-display")),
        ),
      );

  const destroyDisplay: ComputerBackendShape["destroyDisplay"] = (id) =>
    expectOk({ type: "destroy-display", displayId: id });

  const launch: ComputerBackendShape["launch"] = (launchInput) =>
    client
      .request({
        type: "launch",
        app: launchInput.app,
        args: launchInput.args ?? [],
        displayId: launchInput.displayId ?? null,
      })
      .pipe(
        Effect.flatMap((record) =>
          record.type === "launched"
            ? Effect.succeed({ pid: record.pid } satisfies OpenbotComputerLaunchResult)
            : Effect.fail(wrongReply(record, "launch")),
        ),
      );

  const capture: ComputerBackendShape["capture"] = (displayId, profile) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        expectOk({
          type: "capture-start",
          displayId,
          maxWidthPx: profile.maxWidthPx,
          fps: profile.fps,
          quality: profile.quality,
        }),
        // A helper that already died cannot be told to stop, and releasing a
        // capture must never fail the scope that owned it.
        () => expectOk({ type: "capture-stop", displayId }).pipe(Effect.ignore),
      );
      return client.frames.pipe(
        Stream.filter((frame) => frame.displayId === displayId),
        Stream.map((frame) => toComputerFrame(displayId, frame)),
      );
    });

  return ComputerBackend.of({
    platform: "darwin",
    describe,
    listDisplays,
    listWindows,
    focusWindow,
    screenshot,
    capture,
    input,
    createDisplay,
    destroyDisplay,
    launch,
    changes: client.events.pipe(Stream.map((): void => undefined)),
  });
});

export const layer = Layer.effect(ComputerBackend, make());
