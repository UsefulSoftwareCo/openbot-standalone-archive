import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { ComputerBackend } from "./ComputerBackend.ts";
import { layer as linuxLayer } from "./backends/linux/LinuxX11ComputerBackend.ts";
import { layer as macBinaryLayer } from "./backends/mac/ComputerHelperBinary.ts";
import {
  launcherLayer as macLauncherLayer,
  layer as macClientLayer,
} from "./backends/mac/ComputerHelperClient.ts";
import { layer as macLayer } from "./backends/mac/MacComputerBackend.ts";
import { layer as unsupportedLayer, UNSUPPORTED_PLATFORM_REASON } from "./backends/unsupported.ts";

/**
 * Picks the backend for the host this server is actually running on, and is
 * the only place the platform-specific stacks are assembled.
 *
 * The platform comes from the environment descriptor rather than `process`,
 * so this decision is made from the same parsed value every other server
 * capability is derived from. A host we cannot drive still gets a backend:
 * the unsupported one answers every question with its reason, which is what
 * lets the UI say why instead of showing nothing at all.
 */

/** Everything the platform backends need from the server runtime. Named as one
    union so the layer's requirements do not change shape when a backend picks
    up another host service. */
export type ComputerBackendPlatformServices =
  | ServerEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

/** The macOS backend talks to a signed helper app; its client and the binary
    lookup are private to that backend, so they are provided here rather than
    leaking into the server's layer graph. */
const macBackendLayer = macLayer.pipe(
  Layer.provide(macClientLayer.pipe(Layer.provide(macLauncherLayer))),
  Layer.provide(macBinaryLayer),
);

export const layer: Layer.Layer<ComputerBackend, never, ComputerBackendPlatformServices> =
  Layer.unwrap(
    Effect.gen(function* () {
      const environment = yield* ServerEnvironment;
      const descriptor = yield* environment.getDescriptor;
      const selected: Layer.Layer<ComputerBackend, never, ComputerBackendPlatformServices> =
        descriptor.platform.os === "darwin"
          ? macBackendLayer
          : descriptor.platform.os === "linux"
            ? linuxLayer
            : unsupportedLayer(UNSUPPORTED_PLATFORM_REASON);
      return selected;
    }),
  );
