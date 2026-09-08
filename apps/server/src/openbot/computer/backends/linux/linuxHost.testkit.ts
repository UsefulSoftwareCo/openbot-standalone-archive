import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

/**
 * A fake Linux host: a `ChildProcessSpawner` that answers commands from a
 * script and records every spawn and kill, plus a filesystem of named paths.
 *
 * Replacing the spawner is the production seam the backend already uses, so
 * these tests exercise the same argv, the same environment, and the same
 * teardown order the real host would see.
 */

export interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** How the fake host answers one command. */
export interface FakeProcess {
  readonly stdout?: string | Uint8Array | ReadonlyArray<Uint8Array> | undefined;
  /** A stream rather than a string when the test needs to see the reader keep
      up with a chatty child. */
  readonly stderr?: string | Stream.Stream<Uint8Array, PlatformError.PlatformError> | undefined;
  readonly exitCode?: number | undefined;
  /** Set to make the spawn itself fail, as a missing executable does. */
  readonly spawnError?: string | undefined;
  /** Set to leave the process running until it is killed. */
  readonly runsUntilKilled?: boolean | undefined;
}

export interface SpawnRecord extends SpawnedCommand {
  readonly pid: number;
  /** Signals this child was asked to stop with, in order. */
  readonly kills: Array<string>;
}

export interface FakeHost {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly records: ReadonlyArray<SpawnRecord>;
  /** Commands in spawn order, as `"executable arg arg"`. */
  readonly commandLines: () => ReadonlyArray<string>;
  readonly recordsFor: (executable: string) => ReadonlyArray<SpawnRecord>;
  /** Executables in the order they were asked to stop, which is what teardown
      ordering is actually about. */
  readonly killOrder: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

const toStdout = (
  value: FakeProcess["stdout"],
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  if (value === undefined) return Stream.empty;
  if (typeof value === "string") return Stream.make(encoder.encode(value));
  if (value instanceof Uint8Array) return Stream.make(value);
  return Stream.fromIterable(value);
};

const toStderr = (
  value: FakeProcess["stderr"],
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  if (value === undefined) return Stream.empty;
  return typeof value === "string" ? Stream.make(encoder.encode(value)) : value;
};

/**
 * Builds the fake host. `respond` sees each command in spawn order and decides
 * what it does; returning `undefined` means "exit 0 with no output".
 */
export function makeFakeHost(
  respond: (command: SpawnedCommand, index: number) => FakeProcess | undefined,
): FakeHost {
  const records: Array<SpawnRecord> = [];
  const killOrder: Array<string> = [];
  let nextPid = 1000;

  const spawner = ChildProcessSpawner.make((command) => {
    const parsed = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly env?: Record<string, string | undefined>;
        readonly killSignal?: string | undefined;
      };
    };
    const spawned: SpawnedCommand = {
      command: parsed.command,
      args: parsed.args,
      env: parsed.options.env ?? {},
    };
    const behavior = respond(spawned, records.length) ?? {};
    if (behavior.spawnError !== undefined) {
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: behavior.spawnError,
        }),
      );
    }
    nextPid += 1;
    const record: SpawnRecord = { ...spawned, pid: nextPid, kills: [] };
    records.push(record);

    let killed = false;
    const exitCode = Effect.suspend(() =>
      behavior.runsUntilKilled === true && !killed
        ? Effect.never
        : Effect.succeed(ChildProcessSpawner.ExitCode(behavior.exitCode ?? 0)),
    );

    const kill = (options?: { readonly killSignal?: string | undefined }) =>
      Effect.sync(() => {
        killed = true;
        record.kills.push(options?.killSignal ?? "SIGTERM");
        killOrder.push(record.command);
      });

    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(record.pid),
      exitCode,
      isRunning: Effect.sync(() => behavior.runsUntilKilled === true && !killed),
      kill,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: toStdout(behavior.stdout),
      stderr: toStderr(behavior.stderr),
      all: toStdout(behavior.stdout),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

    // The real spawner kills a child that is still running when the scope that
    // acquired it closes, which is how an interrupted command stops. A fake
    // that only killed on request would prove nothing about cancellation.
    return Effect.acquireRelease(Effect.succeed(handle), () =>
      behavior.runsUntilKilled === true && !killed
        ? kill({ killSignal: parsed.options.killSignal })
        : Effect.void,
    );
  });

  return {
    spawner,
    records,
    commandLines: () => records.map((record) => [record.command, ...record.args].join(" ")),
    recordsFor: (executable) => records.filter((record) => record.command === executable),
    killOrder,
  };
}

/** A filesystem where only the named absolute paths exist, every existing file
    is executable, and `/proc/<pid>/comm` answers from `processNames`. */
export function makeFakeFileSystem(input: {
  readonly present?: ReadonlySet<string>;
  readonly files?: Readonly<Record<string, string>>;
}): FileSystem.FileSystem {
  const present = input.present ?? new Set<string>();
  const files = input.files ?? {};
  const exists = (path: string) => present.has(path) || path in files;
  return FileSystem.makeNoop({
    exists: (path) => Effect.succeed(exists(String(path))),
    stat: (path) =>
      exists(String(path))
        ? Effect.succeed({ type: "File", mode: 0o755 } as FileSystem.File.Info)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "stat",
              pathOrDescriptor: String(path),
            }),
          ),
    readFileString: (path) => {
      const contents = files[String(path)];
      return contents === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: String(path),
            }),
          )
        : Effect.succeed(contents);
    },
  });
}

/** The tool paths a fully provisioned host reports. */
export const INSTALLED_TOOL_PATHS = {
  Xvfb: "/usr/bin/Xvfb",
  xdotool: "/usr/bin/xdotool",
  ffmpeg: "/usr/bin/ffmpeg",
  openbox: "/usr/bin/openbox",
  xdpyinfo: "/usr/bin/xdpyinfo",
  xwininfo: "/usr/bin/xwininfo",
  xrandr: "/usr/bin/xrandr",
  wmctrl: "/usr/bin/wmctrl",
} as const;

export const XDPYINFO_OUTPUT = (widthPx: number, heightPx: number) =>
  [
    "name of display:    :60",
    "screen #0:",
    `  dimensions:    ${widthPx}x${heightPx} pixels (423x265 millimeters)`,
  ].join("\n");
