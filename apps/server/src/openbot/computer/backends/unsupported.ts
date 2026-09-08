import {
  NO_COMPUTER_CAPABILITIES,
  OpenbotComputerError,
  type OpenbotComputerPermissions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ComputerBackend, type ComputerBackendShape } from "../ComputerBackend.ts";

const NOT_APPLICABLE: OpenbotComputerPermissions = {
  screenCapture: "not-applicable",
  accessibility: "not-applicable",
  detail: null,
};

/**
 * The backend for hosts we cannot see or drive: Windows, unknown platforms,
 * and any Linux session that is Wayland-only. It answers every question with
 * `unsupported` and the reason, so the UI can say so instead of guessing.
 */
export function makeUnsupportedBackend(reason: string): ComputerBackendShape {
  const unsupported = new OpenbotComputerError({ code: "unsupported", message: reason });
  const fail = Effect.fail(unsupported);
  return {
    platform: "unsupported",
    describe: Effect.succeed({
      session: "unsupported",
      permissions: NOT_APPLICABLE,
      setup: null,
      capabilities: NO_COMPUTER_CAPABILITIES,
      unavailableReason: reason,
    }),
    listDisplays: Effect.succeed([]),
    listWindows: Effect.succeed([]),
    focusWindow: () => fail,
    screenshot: () => fail,
    capture: () => fail,
    input: () => fail,
    createDisplay: () => fail,
    destroyDisplay: () => fail,
    launch: () => fail,
    changes: Stream.never,
  };
}

export const UNSUPPORTED_PLATFORM_REASON =
  "Screen view and control are implemented for macOS and Linux X11 hosts only.";

export const layer = (reason: string = UNSUPPORTED_PLATFORM_REASON) =>
  Layer.succeed(ComputerBackend, ComputerBackend.of(makeUnsupportedBackend(reason)));
