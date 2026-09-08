// `appBundleContaining` is a pure string function on a path the caller already
// holds, so it has no Effect to carry the `Path` service in.
// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

/**
 * Where the macOS computer helper lives on this machine.
 *
 * The helper is a signed `.app` rather than a bare executable because screen
 * recording and accessibility grants are recorded against a bundle identity,
 * and because only a bundle can be opened into the user's login session where
 * a window server exists. Everything here is about finding that bundle across
 * the three layouts it can be in: an explicit override, a packaged install, and
 * a developer build.
 *
 * Platform gating lives above this module. A non-darwin host resolves exactly
 * the same way; it simply has nothing to find.
 */

/** The helper bundle's name, and the executable inside it. */
const HELPER_APP_NAME = "T3ComputerHelper.app";
const HELPER_EXECUTABLE_RELATIVE_PATH = NodePath.join("Contents", "MacOS", "T3ComputerHelper");

/** Where the helper is, and how it must be started. */
export interface ComputerHelperLocation {
  /** The `.app` bundle, when the executable lives inside one. Null only for a
      bare executable override, which cannot be launched into the login
      session. */
  readonly appPath: string | null;
  readonly executablePath: string;
}

/**
 * No candidate path held a runnable helper executable. `candidates` lists every
 * executable path that was tried, in order, so the fix is visible without
 * re-deriving the search.
 */
export class ComputerHelperNotFound extends Schema.TaggedErrorClass<ComputerHelperNotFound>()(
  "ComputerHelperNotFound",
  {
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `The macOS computer helper is missing: build it with \`pnpm build:computer-helper\`, or point T3CODE_COMPUTER_HELPER_PATH at a ${HELPER_APP_NAME} bundle. Tried ${this.candidates.length} path(s): ${this.candidates.join(", ")}`;
  }
}

/**
 * Resolves the helper bundle for this host.
 *
 * `resolve` is re-run per call rather than memoized: a developer can build the
 * helper while the server is already running, and the next attempt should find
 * it.
 */
export class ComputerHelperBinary extends Context.Service<
  ComputerHelperBinary,
  {
    readonly resolve: Effect.Effect<ComputerHelperLocation, ComputerHelperNotFound>;
  }
>()("t3/openbot/computer/backends/mac/ComputerHelperBinary") {}

/**
 * Walks up from an executable to the innermost enclosing `.app`, or null when
 * the executable is not inside a bundle.
 *
 * Innermost wins because bundles nest: a helper embedded in a host app lives at
 * `Host.app/Contents/…/Helper.app`, and it is `Helper.app` that owns the
 * identity the executable runs under.
 */
export const appBundleContaining = (executablePath: string): string | null => {
  let current = NodePath.dirname(executablePath);
  for (;;) {
    if (current.endsWith(".app")) return current;
    const parent = NodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

export const make = Effect.fn("openbot.computer.computerHelperBinary.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;

  const bundleLocation = (appPath: string): ComputerHelperLocation => ({
    appPath,
    executablePath: path.join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH),
  });

  // Packaged installs put the bundle next to the server bundle; the extra
  // parents cover the layouts the desktop app and the npm package produce.
  const packaged = [
    path.resolve(import.meta.dirname, "computer-helper", HELPER_APP_NAME),
    path.resolve(import.meta.dirname, "../computer-helper", HELPER_APP_NAME),
    path.resolve(import.meta.dirname, "../../computer-helper", HELPER_APP_NAME),
  ];

  // This file sits at apps/server/src/openbot/computer/backends/mac, so the
  // repo root is seven parents up. The six-parent variant covers a build that
  // flattens one level, and the three-parent one is the bundled server run
  // from apps/server/dist inside a checkout, which is how the compiled host is
  // started during development.
  const development = [
    path.resolve(
      import.meta.dirname,
      "../../../../../../../native/computer-helper/dist",
      HELPER_APP_NAME,
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../../../native/computer-helper/dist",
      HELPER_APP_NAME,
    ),
    path.resolve(import.meta.dirname, "../../../native/computer-helper/dist", HELPER_APP_NAME),
  ];

  const bundled = [...packaged, ...development].map(bundleLocation);

  const override = environment.T3CODE_COMPUTER_HELPER_PATH;

  /**
   * The override may name either the bundle or the executable inside it. A
   * directory is always read as a bundle, because no executable is a directory
   * and pointing at `Contents/MacOS` is never what someone meant.
   */
  const overrideLocation: Effect.Effect<ComputerHelperLocation | null> =
    override === undefined || override.length === 0
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          if (override.endsWith(".app")) return bundleLocation(override);
          const info = yield* fileSystem.stat(override).pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "Directory") {
            return bundleLocation(override);
          }
          return { appPath: appBundleContaining(override), executablePath: override };
        });

  const resolve: ComputerHelperBinary["Service"]["resolve"] = Effect.gen(function* () {
    const overridden = yield* overrideLocation;
    const candidates = overridden === null ? bundled : [overridden, ...bundled];

    for (const candidate of candidates) {
      const info = yield* fileSystem.stat(candidate.executablePath).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      // A present but unrunnable file is skipped rather than fatal: a stale
      // half-built bundle must not shadow a good one later in the list.
      if (info.value.type !== "File") continue;
      if ((info.value.mode & 0o111) === 0) continue;
      return candidate;
    }

    return yield* new ComputerHelperNotFound({
      candidates: candidates.map((candidate) => candidate.executablePath),
    });
  });

  return ComputerHelperBinary.of({ resolve });
});

export const layer = Layer.effect(ComputerHelperBinary, make());
