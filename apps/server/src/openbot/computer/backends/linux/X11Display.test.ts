import { describe, expect, it } from "@effect/vitest";

import {
  ffmpegArgs,
  ffmpegFrameSize,
  keyCombination,
  keysymForCode,
  mjpegQuality,
  NO_X11_INPUT_HELD,
  parseDisplayName,
  parseXdpyinfoScreen,
  parseXrandrMonitors,
  parseXwininfoGeometry,
  scrollButton,
  scrollSteps,
  splitTypedText,
  xdotoolArgs,
  xvfbArgs,
  type X11InputHeld,
  type X11InputSurface,
} from "./X11Display.ts";

const WHOLE_SCREEN: X11InputSurface = {
  originX: 0,
  originY: 0,
  widthPx: 1600,
  heightPx: 1000,
};

const SECOND_MONITOR: X11InputSurface = {
  originX: 1920,
  originY: 0,
  widthPx: 2560,
  heightPx: 1440,
};

const plan = (
  event: Parameters<typeof xdotoolArgs>[0],
  surface: X11InputSurface = WHOLE_SCREEN,
  held: X11InputHeld = NO_X11_INPUT_HELD,
) => xdotoolArgs(event, { surface, held });

const commandsOf = (result: ReturnType<typeof xdotoolArgs>) => {
  if (result._tag !== "commands") throw new Error(`rejected: ${result.reason}`);
  return result.commands;
};

describe("xvfbArgs", () => {
  it("lets Xvfb claim a display and report it, on a 24-bit screen with no TCP listener", () => {
    expect(xvfbArgs({ widthPx: 1600, heightPx: 1000, displayFd: 1 })).toEqual([
      "-displayfd",
      "1",
      "-screen",
      "0",
      "1600x1000x24",
      "+extension",
      "GLX",
      "+extension",
      "RANDR",
      "+extension",
      "RENDER",
      "-dpi",
      "96",
      "-noreset",
      "-nolisten",
      "tcp",
    ]);
  });
});

describe("ffmpegArgs", () => {
  const base = {
    display: ":60",
    screen: 0,
    x: 0,
    y: 0,
    widthPx: 1600,
    heightPx: 1000,
    fps: 12,
    maxWidthPx: 1600,
    quality: 0.8,
    drawMouse: false,
  };

  it("captures the whole region without a scale filter when nothing is downscaled", () => {
    const args = ffmpegArgs(base);
    expect(args).toContain("x11grab");
    expect(args.join(" ")).toContain("-video_size 1600x1000");
    expect(args.join(" ")).toContain("-i :60.0+0,0");
    expect(args.join(" ")).not.toContain("scale=");
  });

  it("scales only when the frame is narrower than the capture", () => {
    expect(ffmpegArgs({ ...base, maxWidthPx: 800 }).join(" ")).toContain("-vf scale=800:-2");
    expect(ffmpegArgs({ ...base, maxWidthPx: 4000 }).join(" ")).not.toContain("scale=");
  });

  it("rounds an odd region down to even dimensions", () => {
    const args = ffmpegArgs({ ...base, widthPx: 1601, heightPx: 999 });
    expect(args.join(" ")).toContain("-video_size 1600x998");
  });

  it("addresses a monitor by its offset inside the screen", () => {
    const args = ffmpegArgs({ ...base, display: ":0", screen: 1, x: 1920, y: 0 });
    expect(args.join(" ")).toContain("-i :0.1+1920,0");
  });

  it("draws the pointer only for a shared desktop", () => {
    expect(ffmpegArgs({ ...base, drawMouse: true }).join(" ")).toContain("-draw_mouse 1");
    expect(ffmpegArgs(base).join(" ")).toContain("-draw_mouse 0");
  });

  it("asks for a single frame when one was requested", () => {
    expect(ffmpegArgs({ ...base, frames: 1 }).join(" ")).toContain("-frames:v 1");
    expect(ffmpegArgs(base).join(" ")).not.toContain("-frames:v");
  });

  it("maps contract quality onto the mjpeg quantiser, best to worst", () => {
    expect(mjpegQuality(1)).toBe(2);
    expect(mjpegQuality(0.1)).toBe(16);
    expect(mjpegQuality(0)).toBe(18);
    expect(ffmpegArgs({ ...base, quality: 1 }).join(" ")).toContain("-q:v 2");
  });

  it("reports the frame size the arguments actually produce", () => {
    expect(ffmpegFrameSize({ ...base, maxWidthPx: 800 })).toEqual({
      captureWidthPx: 1600,
      captureHeightPx: 1000,
      frameWidthPx: 800,
      frameHeightPx: 500,
    });
    expect(ffmpegFrameSize({ ...base, widthPx: 1920, heightPx: 1080, maxWidthPx: 640 })).toEqual({
      captureWidthPx: 1920,
      captureHeightPx: 1080,
      frameWidthPx: 640,
      frameHeightPx: 360,
    });
  });
});

describe("keysymForCode", () => {
  it("maps letters, digits and function keys by position", () => {
    expect(keysymForCode("KeyA")).toBe("a");
    expect(keysymForCode("KeyZ")).toBe("z");
    expect(keysymForCode("Digit1")).toBe("1");
    expect(keysymForCode("F5")).toBe("F5");
    expect(keysymForCode("F20")).toBe("F20");
  });

  it("uses the X names for navigation and editing keys", () => {
    expect(keysymForCode("Enter")).toBe("Return");
    expect(keysymForCode("Backspace")).toBe("BackSpace");
    expect(keysymForCode("Delete")).toBe("Delete");
    expect(keysymForCode("Space")).toBe("space");
    expect(keysymForCode("Escape")).toBe("Escape");
    expect(keysymForCode("ArrowLeft")).toBe("Left");
    expect(keysymForCode("ArrowDown")).toBe("Down");
    expect(keysymForCode("PageUp")).toBe("Prior");
    expect(keysymForCode("PageDown")).toBe("Next");
  });

  it("maps punctuation, modifiers and the keypad", () => {
    expect(keysymForCode("Minus")).toBe("minus");
    expect(keysymForCode("Equal")).toBe("equal");
    expect(keysymForCode("BracketLeft")).toBe("bracketleft");
    expect(keysymForCode("Quote")).toBe("apostrophe");
    expect(keysymForCode("Backquote")).toBe("grave");
    expect(keysymForCode("Slash")).toBe("slash");
    expect(keysymForCode("Backslash")).toBe("backslash");
    expect(keysymForCode("ShiftLeft")).toBe("Shift_L");
    expect(keysymForCode("ControlRight")).toBe("Control_R");
    expect(keysymForCode("AltLeft")).toBe("Alt_L");
    expect(keysymForCode("MetaLeft")).toBe("Super_L");
    expect(keysymForCode("CapsLock")).toBe("Caps_Lock");
    expect(keysymForCode("Numpad7")).toBe("KP_7");
    expect(keysymForCode("NumpadEnter")).toBe("KP_Enter");
  });

  it("refuses a code it has no mapping for rather than guessing", () => {
    expect(keysymForCode("Lang1")).toBeNull();
    expect(keysymForCode("a")).toBeNull();
    expect(keysymForCode("")).toBeNull();
  });

  it("writes modifiers in xdotool's combination syntax", () => {
    expect(keyCombination("a", ["control", "shift"])).toBe("ctrl+shift+a");
    expect(keyCombination("Return", ["meta"])).toBe("super+Return");
    expect(keyCombination("Tab", ["alt"])).toBe("alt+Tab");
  });
});

describe("xdotoolArgs", () => {
  it("warps the pointer to a rounded, root-relative point", () => {
    expect(commandsOf(plan({ type: "move", point: { x: 10.4, y: 20.6 } }))).toEqual([
      ["mousemove", "10", "21"],
    ]);
  });

  it("clamps a point onto the display and offsets it into the root window", () => {
    expect(commandsOf(plan({ type: "move", point: { x: -5, y: 9999 } }, SECOND_MONITOR))).toEqual([
      ["mousemove", "1920", "1439"],
    ]);
    expect(commandsOf(plan({ type: "move", point: { x: 10, y: 10 } }, SECOND_MONITOR))).toEqual([
      ["mousemove", "1930", "10"],
    ]);
  });

  it("sends a held button as discrete down and up so a drag works", () => {
    const down = plan({
      type: "button",
      button: "left",
      action: "down",
      point: { x: 5, y: 5 },
    });
    expect(commandsOf(down)).toEqual([["mousemove", "5", "5", "mousedown", "1"]]);
    expect(down._tag === "commands" && down.held.buttons).toEqual([1]);

    const up = xdotoolArgs(
      { type: "button", button: "left", action: "up", point: { x: 40, y: 40 } },
      { surface: WHOLE_SCREEN, held: { keys: [], buttons: [1] } },
    );
    expect(commandsOf(up)).toEqual([["mousemove", "40", "40", "mouseup", "1"]]);
    expect(up._tag === "commands" && up.held.buttons).toEqual([]);
  });

  it("repeats a click for a double or triple click", () => {
    expect(
      commandsOf(plan({ type: "click", button: "right", count: 2, point: { x: 1, y: 2 } })),
    ).toEqual([["mousemove", "1", "2", "click", "--repeat", "2", "--delay", "60", "3"]]);
  });

  it("brackets a modified click with its own modifiers and holds none of them", () => {
    const result = plan({
      type: "click",
      button: "left",
      count: 1,
      point: { x: 1, y: 2 },
      modifiers: ["control", "shift"],
    });
    expect(commandsOf(result)[0]).toEqual(["keydown", "--", "ctrl+shift"]);
    expect(commandsOf(result)[2]).toEqual(["keyup", "--", "ctrl+shift"]);
    expect(result._tag === "commands" && result.held).toEqual(NO_X11_INPUT_HELD);
  });

  it("scrolls with the wheel buttons in the browser's sign convention", () => {
    // Positive deltaY moves the page toward its end, which is a wheel-down.
    expect(scrollButton(0, 120)).toBe(5);
    expect(scrollButton(0, -120)).toBe(4);
    expect(scrollButton(120, 0)).toBe(7);
    expect(scrollButton(-120, 0)).toBe(6);
    expect(scrollButton(0, 0)).toBeNull();
    // A larger horizontal delta wins the axis.
    expect(scrollButton(-200, 10)).toBe(6);
  });

  it("turns pixel deltas into a bounded number of wheel steps", () => {
    expect(scrollSteps(40)).toBe(1);
    expect(scrollSteps(5)).toBe(1);
    expect(scrollSteps(-120)).toBe(3);
    expect(scrollSteps(100_000)).toBe(10);
  });

  it("emits one scroll command at the pointer position", () => {
    expect(
      commandsOf(plan({ type: "scroll", point: { x: 8, y: 9 }, deltaX: 0, deltaY: 120 })),
    ).toEqual([["mousemove", "8", "9", "click", "--repeat", "3", "--delay", "10", "5"]]);
  });

  it("rejects a scroll with no delta instead of pressing a random button", () => {
    const result = plan({ type: "scroll", point: { x: 0, y: 0 }, deltaX: 0, deltaY: 0 });
    expect(result).toEqual({ _tag: "rejected", reason: "scroll had no delta" });
  });

  it("tracks held keys so release-all can undo them in reverse order", () => {
    const first = plan({ type: "key", key: "ControlLeft", action: "down" });
    expect(commandsOf(first)).toEqual([["keydown", "--", "Control_L"]]);
    const held = first._tag === "commands" ? first.held : NO_X11_INPUT_HELD;

    const second = xdotoolArgs(
      { type: "key", key: "KeyA", action: "down", modifiers: ["control"] },
      { surface: WHOLE_SCREEN, held },
    );
    expect(commandsOf(second)).toEqual([["keydown", "--", "ctrl+a"]]);

    const release = xdotoolArgs(
      { type: "release-all" },
      {
        surface: WHOLE_SCREEN,
        held: second._tag === "commands" ? { ...second.held, buttons: [3] } : NO_X11_INPUT_HELD,
      },
    );
    expect(commandsOf(release)).toEqual([
      ["keyup", "--", "ctrl+a"],
      ["keyup", "--", "Control_L"],
      ["mouseup", "3"],
    ]);
    expect(release._tag === "commands" && release.held).toEqual(NO_X11_INPUT_HELD);
  });

  it("makes release-all a no-op when nothing is held", () => {
    expect(commandsOf(plan({ type: "release-all" }))).toEqual([]);
  });

  it("presses a key down and up in one command", () => {
    expect(commandsOf(plan({ type: "key-press", key: "Enter", modifiers: ["meta"] }))).toEqual([
      ["key", "--", "super+Return"],
    ]);
  });

  it("rejects an unknown key rather than typing something else", () => {
    expect(plan({ type: "key", key: "Fn", action: "down" })).toEqual({
      _tag: "rejected",
      reason: "unknown key Fn",
    });
    expect(plan({ type: "key-press", key: "Fn" })).toEqual({
      _tag: "rejected",
      reason: "unknown key Fn",
    });
  });

  it("types text after a -- so a leading dash is not read as a flag", () => {
    expect(commandsOf(plan({ type: "text", text: "--version" }))).toEqual([
      ["type", "--delay", "12", "--", "--version"],
    ]);
  });

  it("never passes --sync to mousemove, which hangs when the pointer is already there", () => {
    const events: ReadonlyArray<Parameters<typeof xdotoolArgs>[0]> = [
      { type: "move", point: { x: 10, y: 20 } },
      { type: "button", button: "left", action: "down", point: { x: 10, y: 20 } },
      { type: "button", button: "left", action: "up", point: { x: 10, y: 20 } },
      { type: "click", button: "left", count: 2, point: { x: 10, y: 20 } },
      { type: "click", button: "right", count: 1, point: { x: 10, y: 20 }, modifiers: ["control"] },
      { type: "scroll", point: { x: 10, y: 20 }, deltaX: 0, deltaY: 120 },
      { type: "key", key: "KeyA", action: "down" },
      { type: "key-press", key: "Enter" },
      { type: "text", text: "hi" },
      { type: "release-all" },
    ];
    const argv = events.flatMap((event) =>
      commandsOf(plan(event, WHOLE_SCREEN, { keys: ["ctrl+a"], buttons: [1] })),
    );
    expect(argv.length).toBeGreaterThan(0);
    expect(argv.filter((command) => command.includes("--sync"))).toEqual([]);
  });

  it("issues the same argv for a click at the pointer's current position", () => {
    // The plan carries no pointer position, so a click on the point the last
    // event already moved to is byte-for-byte the first one: a complete
    // warp-then-click that xdotool can finish without waiting for motion.
    const click = { type: "click", button: "left", count: 1, point: { x: 10, y: 20 } } as const;
    const expected = [["mousemove", "10", "20", "click", "--repeat", "1", "--delay", "60", "1"]];
    expect(commandsOf(plan({ type: "move", point: { x: 10, y: 20 } }))).toEqual([
      ["mousemove", "10", "20"],
    ]);
    expect(commandsOf(plan(click))).toEqual(expected);
    expect(commandsOf(plan(click))).toEqual(expected);
  });

  it("types long text as several processes so a stop lands inside one of them", () => {
    const text = "a".repeat(200);
    const commands = commandsOf(plan({ type: "text", text }));
    expect(commands.map((command) => command[4])).toEqual([
      "a".repeat(64),
      "a".repeat(64),
      "a".repeat(64),
      "a".repeat(8),
    ]);
    expect(
      commands.every((command) => command.slice(0, 4).join(" ") === "type --delay 12 --"),
    ).toBe(true);
  });
});

describe("splitTypedText", () => {
  it("leaves anything that fits in one process alone", () => {
    expect(splitTypedText("hello")).toEqual(["hello"]);
    expect(splitTypedText("x".repeat(64))).toEqual(["x".repeat(64)]);
    expect(splitTypedText("")).toEqual([]);
  });

  it("splits into bounded chunks that rejoin to the original", () => {
    const text = Array.from({ length: 500 }, (_, index) => String(index % 10)).join("");
    const chunks = splitTypedText(text);
    expect(chunks).toHaveLength(8);
    expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("never cuts a surrogate pair in half", () => {
    // 31 emoji is 62 UTF-16 units; the 32nd would be the 63rd and 64th, and
    // half of it would be a character xdotool cannot type.
    const text = "😀".repeat(40);
    const chunks = splitTypedText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]).toBe("😀".repeat(32));
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk))).toBe(true);
  });
});

describe("parseDisplayName", () => {
  it("splits the screen suffix off so it is never appended twice", () => {
    expect(parseDisplayName(":0")).toEqual({ base: ":0", screen: 0 });
    expect(parseDisplayName(":0.1")).toEqual({ base: ":0", screen: 1 });
    expect(parseDisplayName(" :60 ")).toEqual({ base: ":60", screen: 0 });
    expect(parseDisplayName("localhost:10.0")).toEqual({ base: "localhost:10", screen: 0 });
  });

  it("rejects anything that is not an X display name", () => {
    expect(parseDisplayName("")).toBeNull();
    expect(parseDisplayName("wayland-0")).toBeNull();
    expect(parseDisplayName(":")).toBeNull();
    expect(parseDisplayName(":abc")).toBeNull();
  });
});

describe("parseXdpyinfoScreen", () => {
  const OUTPUT = [
    "name of display:    :60",
    "version number:    11.0",
    "screen #0:",
    "  dimensions:    1600x1000 pixels (423x265 millimeters)",
    "  resolution:    96x96 dots per inch",
  ].join("\n");

  it("reads the screen dimensions", () => {
    expect(parseXdpyinfoScreen(OUTPUT)).toEqual({ widthPx: 1600, heightPx: 1000 });
  });

  it("returns null when the display never answered", () => {
    expect(parseXdpyinfoScreen("")).toBeNull();
    expect(parseXdpyinfoScreen("xdpyinfo:  unable to open display :60.")).toBeNull();
  });
});

describe("parseXrandrMonitors", () => {
  it("reads each monitor's size, origin, and which one is primary", () => {
    const output = [
      "Monitors: 2",
      " 0: +*eDP-1 1920/344x1080/193+0+0  eDP-1",
      " 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1",
    ].join("\n");
    expect(parseXrandrMonitors(output)).toEqual([
      { name: "eDP-1", widthPx: 1920, heightPx: 1080, x: 0, y: 0, primary: true },
      { name: "HDMI-1", widthPx: 2560, heightPx: 1440, x: 1920, y: 0, primary: false },
    ]);
  });

  it("handles a listing with no physical size and no primary", () => {
    expect(parseXrandrMonitors("Monitors: 1\n 0: +screen 1600x1000+0+0  screen")).toEqual([
      { name: "screen", widthPx: 1600, heightPx: 1000, x: 0, y: 0, primary: false },
    ]);
  });

  it("returns nothing when xrandr said something else", () => {
    expect(parseXrandrMonitors("Can't open display")).toEqual([]);
    expect(parseXrandrMonitors("")).toEqual([]);
  });
});

describe("parseXwininfoGeometry", () => {
  // A reparented Openbox window: the client sits 1,20 inside its frame, and
  // xdotool reports 42,160 for this same window by adding that offset twice.
  const OUTPUT = [
    'xwininfo: Window id: 0x800005 "Terminal"',
    "",
    "  Absolute upper-left X:  41",
    "  Absolute upper-left Y:  140",
    "  Relative upper-left X:  1",
    "  Relative upper-left Y:  20",
    "  Width: 800",
    "  Height: 600",
    "  Depth: 24",
    "  Border width: 0",
    "  Map State: IsViewable",
    "  Corners:  +41+140  -759+140  -759-260  +41-260",
    "  -geometry 80x24+40+139",
  ].join("\n");

  it("reads the window's root-relative origin and size", () => {
    expect(parseXwininfoGeometry(OUTPUT)).toEqual({
      x: 41,
      y: 140,
      widthPx: 800,
      heightPx: 600,
    });
  });

  it("reads a window on a monitor left of the origin", () => {
    const output = OUTPUT.replace("Absolute upper-left X:  41", "Absolute upper-left X:  -1920");
    expect(parseXwininfoGeometry(output)?.x).toBe(-1920);
  });

  it("refuses a partial frame rather than reporting a wrong one", () => {
    expect(parseXwininfoGeometry("xwininfo: error: no such window")).toBeNull();
    expect(parseXwininfoGeometry("  Absolute upper-left X:  41\n  Width: 800\n")).toBeNull();
    expect(parseXwininfoGeometry("")).toBeNull();
  });
});
