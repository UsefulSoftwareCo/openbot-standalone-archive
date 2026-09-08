import type { OpenbotComputerDependency, OpenbotComputerSetup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The host programs the Linux backend drives, and how to get them.
 *
 * A missing tool is an actionable list with a command the user can paste, not
 * a stub that pretends to work: an X11 host with no `xdotool` cannot receive
 * input at all, and the honest answer is which package supplies it.
 */

export const LINUX_COMPUTER_TOOLS = [
  "Xvfb",
  "xdotool",
  "ffmpeg",
  "openbox",
  "xdpyinfo",
  "xwininfo",
  "xrandr",
  "wmctrl",
] as const;

export type LinuxToolName = (typeof LINUX_COMPUTER_TOOLS)[number];

/** Absolute path of each tool, or null when it is not on `PATH`. */
export type LinuxToolPaths = Readonly<Record<LinuxToolName, string | null>>;

export const NO_LINUX_TOOLS: LinuxToolPaths = {
  Xvfb: null,
  xdotool: null,
  ffmpeg: null,
  openbox: null,
  xdpyinfo: null,
  xwininfo: null,
  xrandr: null,
  wmctrl: null,
};

/** Tools every X11 session needs: capture, input, the screen geometry that
    turns a client's coordinates into root-window ones, and the window geometry
    that a reparenting window manager makes xdotool report wrongly. */
export const SHARED_DESKTOP_TOOLS: ReadonlyArray<LinuxToolName> = [
  "xdotool",
  "ffmpeg",
  "xdpyinfo",
  "xwininfo",
];

/** A managed session additionally has to start a desktop of its own. */
export const MANAGED_SESSION_TOOLS: ReadonlyArray<LinuxToolName> = [
  ...SHARED_DESKTOP_TOOLS,
  "Xvfb",
  "openbox",
];

/** Present in the dependency list so the user can see what a multi-monitor or
    window-manager-aware host would gain, never blocking `ready`. */
export const OPTIONAL_TOOLS: ReadonlyArray<LinuxToolName> = ["xrandr", "wmctrl"];

// ---------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------

export type LinuxPackageManager = "apt" | "dnf" | "pacman";

/** Where each package manager lives, in the order we prefer to find them. A
    path rather than a `PATH` lookup: this identifies the distribution, and a
    stray `apt-get` shim in a user's `~/bin` does not make a host Debian. */
const PACKAGE_MANAGER_PATHS: ReadonlyArray<readonly [LinuxPackageManager, string]> = [
  ["apt", "/usr/bin/apt-get"],
  ["dnf", "/usr/bin/dnf"],
  ["pacman", "/usr/bin/pacman"],
];

const PACKAGES: Readonly<Record<LinuxPackageManager, Readonly<Record<LinuxToolName, string>>>> = {
  apt: {
    Xvfb: "xvfb",
    xdotool: "xdotool",
    ffmpeg: "ffmpeg",
    openbox: "openbox",
    xdpyinfo: "x11-utils",
    xwininfo: "x11-utils",
    xrandr: "x11-xserver-utils",
    wmctrl: "wmctrl",
  },
  dnf: {
    Xvfb: "xorg-x11-server-Xvfb",
    xdotool: "xdotool",
    ffmpeg: "ffmpeg",
    openbox: "openbox",
    xdpyinfo: "xdpyinfo",
    xwininfo: "xwininfo",
    xrandr: "xrandr",
    wmctrl: "wmctrl",
  },
  pacman: {
    Xvfb: "xorg-server-xvfb",
    xdotool: "xdotool",
    ffmpeg: "ffmpeg",
    openbox: "openbox",
    xdpyinfo: "xorg-xdpyinfo",
    xwininfo: "xorg-xwininfo",
    xrandr: "xorg-xrandr",
    wmctrl: "wmctrl",
  },
};

const INSTALL_PREFIX: Readonly<Record<LinuxPackageManager, ReadonlyArray<string>>> = {
  apt: ["sudo", "apt-get", "install", "-y"],
  dnf: ["sudo", "dnf", "install", "-y"],
  pacman: ["sudo", "pacman", "-S", "--needed"],
};

/**
 * One shell command that installs the named tools with this package manager,
 * or null when the host's distribution was not recognised. Duplicate packages
 * collapse, because `x11-utils` supplies more than one tool on Debian.
 */
export function installCommand(
  manager: LinuxPackageManager | null,
  tools: ReadonlyArray<LinuxToolName>,
): string | null {
  if (manager === null || tools.length === 0) return null;
  const packages = [...new Set(tools.map((tool) => PACKAGES[manager][tool]))];
  return [...INSTALL_PREFIX[manager], ...packages].join(" ");
}

/** Identifies the distribution's package manager, or null when it is one we
    have no install plan for. */
export const detectPackageManager = (
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<LinuxPackageManager | null> =>
  Effect.gen(function* () {
    for (const [manager, path] of PACKAGE_MANAGER_PATHS) {
      const present = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
      if (present) return manager;
    }
    return null;
  });

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Finds the tools on `PATH`.
 *
 * A `stat` per candidate rather than a `which` subprocess: this runs on every
 * status read, and one process per tool to answer a question the filesystem
 * already knows is exactly the kind of cost that shows up as a laggy status
 * card.
 */
export const discoverLinuxTools = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<LinuxToolPaths> =>
  Effect.gen(function* () {
    const { fileSystem, path, environment } = input;
    const directories = (environment.PATH ?? "")
      .split(":")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    const isExecutableFile = (candidate: string) =>
      fileSystem.stat(candidate).pipe(
        Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
        Effect.orElseSucceed(() => false),
      );

    const resolve = (tool: LinuxToolName) =>
      Effect.gen(function* () {
        for (const directory of directories) {
          const candidate = path.join(directory, tool);
          if (yield* isExecutableFile(candidate)) return candidate;
        }
        return null;
      });

    const resolved = yield* Effect.forEach(LINUX_COMPUTER_TOOLS, (tool) =>
      resolve(tool).pipe(Effect.map((found) => [tool, found] as const)),
    );
    return Object.fromEntries(resolved) as LinuxToolPaths;
  });

// ---------------------------------------------------------------------------
// Setup report
// ---------------------------------------------------------------------------

/** Which set of tools has to be present for the host to be usable: a host with
    a desktop already needs less than one that has to start its own. */
export type LinuxSetupTarget = "shared-desktop" | "managed-session";

export function requiredTools(target: LinuxSetupTarget): ReadonlyArray<LinuxToolName> {
  return target === "shared-desktop" ? SHARED_DESKTOP_TOOLS : MANAGED_SESSION_TOOLS;
}

const OPTIONAL_NOTES: Readonly<Record<string, string>> = {
  xrandr:
    "xrandr is not installed, so a multi-monitor X screen is offered as one large display instead of one display per monitor.",
  wmctrl:
    "wmctrl is not installed. Window listing and focus still work without it; wmctrl only adds desktop-level details.",
};

/**
 * The host setup report for one session kind: every tool with its path, a
 * per-tool install command, and one combined command in the notes so the fix
 * is a single paste.
 *
 * `ready` covers only the tools that session kind actually needs, so a
 * headless host is not told it is broken for lacking a window manager it will
 * never start.
 */
export function linuxComputerSetup(input: {
  readonly tools: LinuxToolPaths;
  readonly packageManager: LinuxPackageManager | null;
  readonly target: LinuxSetupTarget;
  readonly extraNotes?: ReadonlyArray<string>;
}): OpenbotComputerSetup {
  const required = requiredTools(input.target);
  const dependencies: ReadonlyArray<OpenbotComputerDependency> = LINUX_COMPUTER_TOOLS.map(
    (tool) => ({
      name: tool,
      present: input.tools[tool] !== null,
      path: input.tools[tool],
      install: installCommand(input.packageManager, [tool]),
    }),
  );
  const missingRequired = required.filter((tool) => input.tools[tool] === null);
  const notes: Array<string> = [...(input.extraNotes ?? [])];

  if (missingRequired.length > 0) {
    notes.push(
      `Missing ${missingRequired.join(", ")}. Screen view and control stay unavailable until they are installed.`,
    );
    const command = installCommand(input.packageManager, [...required, ...OPTIONAL_TOOLS]);
    if (command === null) {
      notes.push(
        "This host's package manager was not recognised (no apt-get, dnf, or pacman), so install the missing programs the way this distribution does.",
      );
    } else {
      notes.push(`Install everything at once with: ${command}`);
    }
  }
  for (const tool of OPTIONAL_TOOLS) {
    const note = OPTIONAL_NOTES[tool];
    if (input.tools[tool] === null && note !== undefined) notes.push(note);
  }

  return { ready: missingRequired.length === 0, dependencies, notes };
}
