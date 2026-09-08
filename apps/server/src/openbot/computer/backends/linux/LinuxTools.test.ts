import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  detectPackageManager,
  discoverLinuxTools,
  installCommand,
  linuxComputerSetup,
  NO_LINUX_TOOLS,
  type LinuxToolName,
  type LinuxToolPaths,
} from "./LinuxTools.ts";

/** A filesystem where only the named absolute paths exist, and every file that
    exists is executable. */
function fakeFileSystem(present: ReadonlySet<string>): FileSystem.FileSystem {
  return FileSystem.makeNoop({
    exists: (path) => Effect.succeed(present.has(String(path))),
    stat: (path) =>
      present.has(String(path))
        ? Effect.succeed({ type: "File", mode: 0o755 } as FileSystem.File.Info)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "stat",
              pathOrDescriptor: String(path),
            }),
          ),
  });
}

const discover = (present: ReadonlySet<string>, environment: Record<string, string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* discoverLinuxTools({
      fileSystem: fakeFileSystem(present),
      path,
      environment,
    });
  }).pipe(Effect.provide(Path.layer));

const toolPaths = (overrides: Partial<Record<LinuxToolName, string>>): LinuxToolPaths => ({
  ...NO_LINUX_TOOLS,
  ...overrides,
});

const ALL_PRESENT = toolPaths({
  Xvfb: "/usr/bin/Xvfb",
  xdotool: "/usr/bin/xdotool",
  ffmpeg: "/usr/bin/ffmpeg",
  openbox: "/usr/bin/openbox",
  xdpyinfo: "/usr/bin/xdpyinfo",
  xrandr: "/usr/bin/xrandr",
  wmctrl: "/usr/bin/wmctrl",
});

describe("discoverLinuxTools", () => {
  it.effect("finds each tool in the first PATH directory that has it", () =>
    Effect.gen(function* () {
      const tools = yield* discover(
        new Set(["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/usr/bin/xdotool"]),
        { PATH: "/usr/local/bin:/usr/bin" },
      );
      expect(tools.ffmpeg).toBe("/usr/local/bin/ffmpeg");
      expect(tools.xdotool).toBe("/usr/bin/xdotool");
      expect(tools.Xvfb).toBeNull();
    }),
  );

  it.effect("reports every tool as missing when PATH is empty", () =>
    Effect.gen(function* () {
      const tools = yield* discover(new Set(["/usr/bin/ffmpeg"]), {});
      expect(tools).toEqual(NO_LINUX_TOOLS);
    }),
  );

  it.effect("skips blank PATH entries instead of probing the working directory", () =>
    Effect.gen(function* () {
      const tools = yield* discover(new Set(["ffmpeg", "/usr/bin/ffmpeg"]), {
        PATH: ":: :/usr/bin",
      });
      expect(tools.ffmpeg).toBe("/usr/bin/ffmpeg");
    }),
  );
});

describe("detectPackageManager", () => {
  it.effect("identifies the distribution from its package manager", () =>
    Effect.gen(function* () {
      expect(yield* detectPackageManager(fakeFileSystem(new Set(["/usr/bin/apt-get"])))).toBe(
        "apt",
      );
      expect(yield* detectPackageManager(fakeFileSystem(new Set(["/usr/bin/dnf"])))).toBe("dnf");
      expect(yield* detectPackageManager(fakeFileSystem(new Set(["/usr/bin/pacman"])))).toBe(
        "pacman",
      );
      expect(yield* detectPackageManager(fakeFileSystem(new Set()))).toBeNull();
    }),
  );
});

describe("installCommand", () => {
  it("names the right package for each tool on each distribution", () => {
    expect(
      installCommand("apt", ["Xvfb", "xdotool", "ffmpeg", "openbox", "xdpyinfo", "xrandr"]),
    ).toBe("sudo apt-get install -y xvfb xdotool ffmpeg openbox x11-utils x11-xserver-utils");
    expect(
      installCommand("dnf", ["Xvfb", "xdotool", "ffmpeg", "openbox", "xdpyinfo", "xrandr"]),
    ).toBe("sudo dnf install -y xorg-x11-server-Xvfb xdotool ffmpeg openbox xdpyinfo xrandr");
    expect(
      installCommand("pacman", ["Xvfb", "xdotool", "ffmpeg", "openbox", "xdpyinfo", "xrandr"]),
    ).toBe(
      "sudo pacman -S --needed xorg-server-xvfb xdotool ffmpeg openbox xorg-xdpyinfo xorg-xrandr",
    );
  });

  it("collapses tools that share one package", () => {
    expect(installCommand("apt", ["xdpyinfo", "xdpyinfo"])).toBe(
      "sudo apt-get install -y x11-utils",
    );
  });

  it("has no plan for an unrecognised distribution", () => {
    expect(installCommand(null, ["ffmpeg"])).toBeNull();
    expect(installCommand("apt", [])).toBeNull();
  });
});

describe("linuxComputerSetup", () => {
  it("is ready when a shared desktop has capture, input, and geometry", () => {
    const setup = linuxComputerSetup({
      tools: toolPaths({
        xdotool: "/usr/bin/xdotool",
        ffmpeg: "/usr/bin/ffmpeg",
        xdpyinfo: "/usr/bin/xdpyinfo",
        xrandr: "/usr/bin/xrandr",
        wmctrl: "/usr/bin/wmctrl",
      }),
      packageManager: "apt",
      target: "shared-desktop",
    });
    expect(setup.ready).toBe(true);
    expect(setup.notes).toEqual([]);
  });

  it("does not demand a window manager from a host that shares an existing desktop", () => {
    const tools = toolPaths({
      xdotool: "/usr/bin/xdotool",
      ffmpeg: "/usr/bin/ffmpeg",
      xdpyinfo: "/usr/bin/xdpyinfo",
      xrandr: "/usr/bin/xrandr",
      wmctrl: "/usr/bin/wmctrl",
    });
    expect(
      linuxComputerSetup({ tools, packageManager: "apt", target: "shared-desktop" }).ready,
    ).toBe(true);
    const managed = linuxComputerSetup({ tools, packageManager: "apt", target: "managed-session" });
    expect(managed.ready).toBe(false);
    expect(managed.notes[0]).toContain("Xvfb, openbox");
  });

  it("lists every tool with its path and its own install command", () => {
    const setup = linuxComputerSetup({
      tools: toolPaths({ ffmpeg: "/usr/bin/ffmpeg" }),
      packageManager: "pacman",
      target: "managed-session",
    });
    expect(setup.dependencies).toContainEqual({
      name: "ffmpeg",
      present: true,
      path: "/usr/bin/ffmpeg",
      install: "sudo pacman -S --needed ffmpeg",
    });
    expect(setup.dependencies).toContainEqual({
      name: "Xvfb",
      present: false,
      path: null,
      install: "sudo pacman -S --needed xorg-server-xvfb",
    });
  });

  it("gives one command that installs everything the host is missing", () => {
    const setup = linuxComputerSetup({
      tools: NO_LINUX_TOOLS,
      packageManager: "apt",
      target: "managed-session",
    });
    expect(setup.ready).toBe(false);
    expect(setup.notes).toContain(
      "Install everything at once with: sudo apt-get install -y xdotool ffmpeg x11-utils xvfb openbox x11-xserver-utils wmctrl",
    );
  });

  it("says so plainly when it cannot name the package manager", () => {
    const setup = linuxComputerSetup({
      tools: NO_LINUX_TOOLS,
      packageManager: null,
      target: "shared-desktop",
    });
    expect(setup.dependencies.every((dependency) => dependency.install === null)).toBe(true);
    expect(setup.notes.some((note) => note.includes("was not recognised"))).toBe(true);
  });

  it("mentions a missing optional tool without blocking readiness", () => {
    const setup = linuxComputerSetup({
      tools: toolPaths({
        xdotool: "/usr/bin/xdotool",
        ffmpeg: "/usr/bin/ffmpeg",
        xdpyinfo: "/usr/bin/xdpyinfo",
      }),
      packageManager: "apt",
      target: "shared-desktop",
    });
    expect(setup.ready).toBe(true);
    expect(setup.notes.some((note) => note.startsWith("xrandr is not installed"))).toBe(true);
  });

  it("keeps the caller's own notes, such as the XWayland caveat", () => {
    const setup = linuxComputerSetup({
      tools: ALL_PRESENT,
      packageManager: "apt",
      target: "shared-desktop",
      extraNotes: ["only X11 windows are visible"],
    });
    expect(setup.notes).toEqual(["only X11 windows are visible"]);
  });
});
