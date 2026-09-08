// The repo-root walk and the path arithmetic under test both have to happen
// outside an Effect, at module load, to decide which cases can be asserted.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ComputerHelperBinary from "./ComputerHelperBinary.ts";

const HELPER_EXECUTABLE_RELATIVE_PATH = NodePath.join("Contents", "MacOS", "T3ComputerHelper");

// The exec-bit check cannot be satisfied on NTFS, which never reports POSIX
// mode bits. The helper is macOS-only anyway; these tests exercise the search,
// not the platform.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

/** The repo root, found independently of the module under test so the test is
    real evidence that its dev-path arithmetic lands on this checkout. */
const repoRoot = (() => {
  let current = import.meta.dirname;
  for (;;) {
    if (NodeFS.existsSync(NodePath.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = NodePath.dirname(current);
    if (parent === current) throw new Error("could not find the repo root from the test file");
    current = parent;
  }
})();

const devHelperExecutable = NodePath.join(
  repoRoot,
  "native/computer-helper/dist/T3ComputerHelper.app",
  HELPER_EXECUTABLE_RELATIVE_PATH,
);

// A developer who has actually built the helper resolves it for real, which
// makes the "nothing is installed" assertions untestable on that machine.
const devBuildPresent = NodeFS.existsSync(devHelperExecutable);

const makeHelper = (environment: NodeJS.ProcessEnv) =>
  ComputerHelperBinary.make().pipe(Effect.provideService(HostProcessEnvironment, environment));

const writeExecutable = Effect.fn("test.writeExecutable")(function* (
  path: string,
  mode: number = 0o755,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(NodePath.dirname(path), { recursive: true });
  yield* fileSystem.writeFileString(path, "#!/bin/sh\nexit 0\n");
  yield* fileSystem.chmod(path, mode);
});

const tempDirectory = Effect.fn("test.tempDirectory")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-computer-helper-" });
});

describe("appBundleContaining", () => {
  it("finds the innermost enclosing bundle", () => {
    assert.equal(
      ComputerHelperBinary.appBundleContaining(
        "/opt/Host.app/Contents/Library/T3ComputerHelper.app/Contents/MacOS/T3ComputerHelper",
      ),
      "/opt/Host.app/Contents/Library/T3ComputerHelper.app",
    );
  });

  it("returns null for an executable outside any bundle", () => {
    assert.equal(ComputerHelperBinary.appBundleContaining("/usr/local/bin/helper"), null);
  });

  it("returns null rather than looping at the filesystem root", () => {
    assert.equal(ComputerHelperBinary.appBundleContaining("/helper"), null);
  });
});

describe("ComputerHelperNotFound", () => {
  it("names the build command and every path it tried", () => {
    const error = new ComputerHelperBinary.ComputerHelperNotFound({
      candidates: ["/one/T3ComputerHelper", "/two/T3ComputerHelper"],
    });
    expect(error.message).toContain("build it with `pnpm build:computer-helper`");
    expect(error.message).toContain("/one/T3ComputerHelper");
    expect(error.message).toContain("/two/T3ComputerHelper");
  });
});

describe("ComputerHelperBinary", () => {
  it.effect.skipIf(windowsHost)("resolves an override naming an app bundle", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempDirectory();
      const appPath = NodePath.join(baseDir, "T3ComputerHelper.app");
      const executablePath = NodePath.join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH);
      yield* writeExecutable(executablePath);

      const service = yield* makeHelper({ T3CODE_COMPUTER_HELPER_PATH: appPath });

      assert.deepEqual(yield* service.resolve, { appPath, executablePath });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("reads an override naming a directory as a bundle", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempDirectory();
      const appPath = NodePath.join(baseDir, "helper-out");
      const executablePath = NodePath.join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH);
      yield* writeExecutable(executablePath);

      const service = yield* makeHelper({ T3CODE_COMPUTER_HELPER_PATH: appPath });

      assert.deepEqual(yield* service.resolve, { appPath, executablePath });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("resolves a bare executable override and recovers its bundle", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempDirectory();
      const appPath = NodePath.join(baseDir, "Custom.app");
      const executablePath = NodePath.join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH);
      yield* writeExecutable(executablePath);

      const service = yield* makeHelper({ T3CODE_COMPUTER_HELPER_PATH: executablePath });

      assert.deepEqual(yield* service.resolve, { appPath, executablePath });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)(
    "resolves a bare executable override with no bundle around it",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempDirectory();
        const executablePath = NodePath.join(baseDir, "bin", "t3-computer-helper");
        yield* writeExecutable(executablePath);

        const service = yield* makeHelper({ T3CODE_COMPUTER_HELPER_PATH: executablePath });

        assert.deepEqual(yield* service.resolve, { appPath: null, executablePath });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost || devBuildPresent)("skips an override that is not executable", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempDirectory();
      const executablePath = NodePath.join(baseDir, "T3ComputerHelper");
      yield* writeExecutable(executablePath, 0o644);

      const service = yield* makeHelper({ T3CODE_COMPUTER_HELPER_PATH: executablePath });
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ComputerHelperBinary.ComputerHelperNotFound);
      assert.equal(error.candidates[0], executablePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(devBuildPresent)("searches this checkout's dev build path", () =>
    Effect.gen(function* () {
      const service = yield* makeHelper({});
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ComputerHelperBinary.ComputerHelperNotFound);
      expect(error.candidates).toContain(devHelperExecutable);
      // Every candidate names the executable inside a bundle, never the bundle.
      for (const candidate of error.candidates) {
        expect(candidate.endsWith(HELPER_EXECUTABLE_RELATIVE_PATH)).toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(devBuildPresent)("searches packaged paths beside the server bundle", () =>
    Effect.gen(function* () {
      const service = yield* makeHelper({});
      const error = yield* Effect.flip(service.resolve);

      expect(
        error.candidates.some((candidate) =>
          candidate.startsWith(NodePath.join(import.meta.dirname, "computer-helper")),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("prefers the override over every bundled candidate", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempDirectory();
      const appPath = NodePath.join(baseDir, "T3ComputerHelper.app");
      const executablePath = NodePath.join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH);
      yield* writeExecutable(executablePath);

      const service = yield* makeHelper({ T3CODE_COMPUTER_HELPER_PATH: appPath });
      const location = yield* service.resolve;

      assert.equal(location.executablePath, executablePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(devBuildPresent)("ignores an empty override", () =>
    Effect.gen(function* () {
      const service = yield* makeHelper({ T3CODE_COMPUTER_HELPER_PATH: "" });
      const error = yield* Effect.flip(service.resolve);

      expect(error.candidates).toContain(devHelperExecutable);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("is provided by its layer", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempDirectory();
      const appPath = NodePath.join(baseDir, "T3ComputerHelper.app");
      const executablePath = NodePath.join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH);
      yield* writeExecutable(executablePath);

      const location = yield* Effect.gen(function* () {
        const binary = yield* ComputerHelperBinary.ComputerHelperBinary;
        return yield* binary.resolve;
      }).pipe(
        Effect.provide(ComputerHelperBinary.layer),
        Effect.provideService(HostProcessEnvironment, { T3CODE_COMPUTER_HELPER_PATH: appPath }),
      );

      assert.equal(location.executablePath, executablePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
