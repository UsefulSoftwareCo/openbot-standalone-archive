import type {
  OpenbotComputerInputEvent,
  OpenbotComputerModifier,
  OpenbotComputerMouseButton,
} from "@t3tools/contracts";

/**
 * Every X11 mechanic the Linux backend needs, as pure functions over values.
 *
 * The backend spawns processes and owns state; this module decides *what* to
 * run and *how to read* what came back. Argv arrays and parsers are where the
 * platform's real complexity lives, and they are the part that can be proven
 * on a machine with no X server at all.
 */

// ---------------------------------------------------------------------------
// Xvfb
// ---------------------------------------------------------------------------

/** The default managed session size. Large enough for a real browser window,
    small enough that a 12 fps MJPEG stream stays comfortable over a tunnel. */
export const DEFAULT_MANAGED_WIDTH_PX = 1600;
export const DEFAULT_MANAGED_HEIGHT_PX = 1000;

/**
 * Arguments for the headless X server backing one managed session.
 *
 * The display number is Xvfb's to choose: with `-displayfd` it scans for a free
 * number, binds it, and only then writes it back on that descriptor. Picking a
 * number here instead would be a scan whose result another process can take
 * between the check and the bind, and the loser of that race silently starts a
 * window manager on the winner's desktop.
 *
 * `-noreset` keeps the server alive when the last client disconnects, which
 * otherwise resets every X resource between two app launches. `-nolisten tcp`
 * keeps the display reachable only through its Unix socket: a managed session
 * is a local implementation detail, never a network service.
 */
export function xvfbArgs(options: {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Descriptor Xvfb writes the display number to, as a decimal line. */
  readonly displayFd: number;
}): ReadonlyArray<string> {
  const { widthPx, heightPx, displayFd } = options;
  return [
    "-displayfd",
    String(displayFd),
    "-screen",
    "0",
    `${widthPx}x${heightPx}x24`,
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
  ];
}

// ---------------------------------------------------------------------------
// ffmpeg capture
// ---------------------------------------------------------------------------

export interface FfmpegCaptureSpec {
  /** The X display name, as `DISPLAY` would carry it: ":0", ":60". */
  readonly display: string;
  readonly screen: number;
  /** Top-left of the captured region inside that screen's root window. */
  readonly x: number;
  readonly y: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly fps: number;
  /** Longest edge of the encoded frame. Larger than the region means no scale. */
  readonly maxWidthPx: number;
  /** 0.1 (smallest) to 1 (best). */
  readonly quality: number;
  /** True only for a shared desktop: Xvfb has no hardware cursor for x11grab
      to fetch, and asking for one logs a pointer-query error per capture. */
  readonly drawMouse: boolean;
  /** Set to 1 for a screenshot; null streams until the process is stopped. */
  readonly frames?: number | null;
}

/** x11grab and the mjpeg encoder both want even dimensions; an odd request
    silently costs a column or produces a chroma-alignment warning per frame. */
function evenDown(value: number): number {
  const rounded = Math.floor(value);
  return rounded - (rounded % 2);
}

export interface FfmpegFrameSize {
  readonly captureWidthPx: number;
  readonly captureHeightPx: number;
  readonly frameWidthPx: number;
  readonly frameHeightPx: number;
}

/**
 * The pixel sizes a capture will actually produce: what x11grab reads, and
 * what comes out after the optional downscale. Callers report these to viewers
 * before the first frame arrives, so they must match `ffmpegArgs` exactly.
 */
export function ffmpegFrameSize(spec: FfmpegCaptureSpec): FfmpegFrameSize {
  const captureWidthPx = Math.max(2, evenDown(spec.widthPx));
  const captureHeightPx = Math.max(2, evenDown(spec.heightPx));
  const target = Math.max(2, evenDown(spec.maxWidthPx));
  if (target >= captureWidthPx) {
    return {
      captureWidthPx,
      captureHeightPx,
      frameWidthPx: captureWidthPx,
      frameHeightPx: captureHeightPx,
    };
  }
  // `scale=W:-2` picks the even height nearest the aspect ratio.
  const scaledHeight = Math.max(2, evenDown((captureHeightPx * target) / captureWidthPx + 1));
  return {
    captureWidthPx,
    captureHeightPx,
    frameWidthPx: target,
    frameHeightPx: scaledHeight,
  };
}

/** ffmpeg's mjpeg quantiser scale runs 2 (best) to 31 (worst), the opposite
    direction from the contract's 0.1..1 quality. */
export function mjpegQuality(quality: number): number {
  return Math.min(31, Math.max(2, Math.round(2 + (1 - quality) * 16)));
}

/** Arguments for one x11grab capture, emitting a raw MJPEG byte stream on
    stdout that `splitJpegChunk` cuts back into whole frames. */
export function ffmpegArgs(spec: FfmpegCaptureSpec): ReadonlyArray<string> {
  const size = ffmpegFrameSize(spec);
  const scale =
    size.frameWidthPx === size.captureWidthPx ? [] : ["-vf", `scale=${size.frameWidthPx}:-2`];
  const frames = spec.frames == null ? [] : ["-frames:v", String(spec.frames)];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "x11grab",
    "-draw_mouse",
    spec.drawMouse ? "1" : "0",
    "-framerate",
    String(spec.fps),
    "-video_size",
    `${size.captureWidthPx}x${size.captureHeightPx}`,
    "-i",
    `${spec.display}.${spec.screen}+${spec.x},${spec.y}`,
    ...scale,
    ...frames,
    "-q:v",
    String(mjpegQuality(spec.quality)),
    "-f",
    "mjpeg",
    "-",
  ];
}

// ---------------------------------------------------------------------------
// W3C key codes to X keysyms
// ---------------------------------------------------------------------------

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function buildKeysyms(): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  for (const letter of LETTERS) table.set(`Key${letter.toUpperCase()}`, letter);
  for (let digit = 0; digit <= 9; digit += 1) table.set(`Digit${digit}`, String(digit));
  for (let index = 1; index <= 20; index += 1) table.set(`F${index}`, `F${index}`);
  for (let digit = 0; digit <= 9; digit += 1) table.set(`Numpad${digit}`, `KP_${digit}`);
  const named: Readonly<Record<string, string>> = {
    // Editing and whitespace.
    Enter: "Return",
    Tab: "Tab",
    Space: "space",
    Backspace: "BackSpace",
    Delete: "Delete",
    Insert: "Insert",
    Escape: "Escape",
    // Navigation.
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    Home: "Home",
    End: "End",
    PageUp: "Prior",
    PageDown: "Next",
    // Punctuation, named by position exactly as the W3C code is.
    Minus: "minus",
    Equal: "equal",
    BracketLeft: "bracketleft",
    BracketRight: "bracketright",
    Backslash: "backslash",
    Semicolon: "semicolon",
    Quote: "apostrophe",
    Backquote: "grave",
    Comma: "comma",
    Period: "period",
    Slash: "slash",
    IntlBackslash: "less",
    // Modifiers. X11 distinguishes left from right, and so does the contract.
    ShiftLeft: "Shift_L",
    ShiftRight: "Shift_R",
    ControlLeft: "Control_L",
    ControlRight: "Control_R",
    AltLeft: "Alt_L",
    AltRight: "Alt_R",
    MetaLeft: "Super_L",
    MetaRight: "Super_R",
    CapsLock: "Caps_Lock",
    NumLock: "Num_Lock",
    ScrollLock: "Scroll_Lock",
    ContextMenu: "Menu",
    PrintScreen: "Print",
    Pause: "Pause",
    // Numeric keypad, beyond its digits.
    NumpadDecimal: "KP_Decimal",
    NumpadAdd: "KP_Add",
    NumpadSubtract: "KP_Subtract",
    NumpadMultiply: "KP_Multiply",
    NumpadDivide: "KP_Divide",
    NumpadEnter: "KP_Enter",
    NumpadEqual: "KP_Equal",
    NumpadComma: "KP_Separator",
    // Media keys a browser reports and a desktop acts on.
    AudioVolumeMute: "XF86AudioMute",
    AudioVolumeDown: "XF86AudioLowerVolume",
    AudioVolumeUp: "XF86AudioRaiseVolume",
    MediaPlayPause: "XF86AudioPlay",
    MediaStop: "XF86AudioStop",
    MediaTrackNext: "XF86AudioNext",
    MediaTrackPrevious: "XF86AudioPrev",
    BrowserBack: "XF86Back",
    BrowserForward: "XF86Forward",
    BrowserRefresh: "XF86Refresh",
    BrowserHome: "XF86HomePage",
  };
  for (const [code, keysym] of Object.entries(named)) table.set(code, keysym);
  return table;
}

const KEYSYMS = buildKeysyms();

/**
 * The X keysym for a W3C `KeyboardEvent.code`, or null when this backend has
 * no mapping. Null is a rejection the caller reports per event: guessing a
 * keysym from an unknown code is how a shortcut turns into typed garbage on
 * somebody's real desktop.
 */
export function keysymForCode(code: string): string | null {
  return KEYSYMS.get(code) ?? null;
}

const MODIFIER_KEYSYMS: Readonly<Record<OpenbotComputerModifier, string>> = {
  shift: "shift",
  control: "ctrl",
  alt: "alt",
  meta: "super",
};

/** xdotool's own combination syntax: `ctrl+shift+a`. */
export function keyCombination(
  keysym: string,
  modifiers: ReadonlyArray<OpenbotComputerModifier>,
): string {
  return [...modifiers.map((modifier) => MODIFIER_KEYSYMS[modifier]), keysym].join("+");
}

const BUTTON_NUMBERS: Readonly<Record<OpenbotComputerMouseButton, number>> = {
  left: 1,
  middle: 2,
  right: 3,
};

// ---------------------------------------------------------------------------
// Input planning
// ---------------------------------------------------------------------------

/** The display region input coordinates are expressed in. `originX`/`originY`
    place it inside the X screen's root window, which is the only coordinate
    space `xdotool mousemove` understands. */
export interface X11InputSurface {
  readonly originX: number;
  readonly originY: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * What this display is currently holding down, in press order.
 *
 * Held state is what makes `release-all` possible, and `release-all` is what
 * keeps a dropped WebSocket from leaving a modifier stuck on a desktop a human
 * is also using. Combinations are stored exactly as they were pressed, so the
 * release is the symmetric `keyup`.
 */
export interface X11InputHeld {
  readonly keys: ReadonlyArray<string>;
  readonly buttons: ReadonlyArray<number>;
}

export const NO_X11_INPUT_HELD: X11InputHeld = { keys: [], buttons: [] };

/**
 * One xdotool invocation and the held state the display is in once it exits.
 *
 * A unit is the smallest thing the backend runs, and it runs it whole: spawn,
 * wait for exit, write this `held` down, with no interruption in between.
 *
 * That indivisibility is the point. `xdotool type` presses and releases each
 * character itself, so killing it between a press and its release leaves that
 * key down inside the X server and outside every held set anything tracks.
 * Measured on a real display: a killed `type` chunk left keycode 53 down, and
 * X11 autorepeat then typed 985 more characters after the stop was
 * acknowledged. The same gap exists inside `key` (a press and a release in one
 * process) and inside a modified click (modifiers pressed and released around
 * it), and between any process finishing and its held-state fold.
 *
 * So cancellation is only ever observed between units, and every unit is kept
 * short enough that waiting for one is not a hang: `type` is capped at
 * {@link TEXT_CHUNK_MAX_UNITS} characters at `--delay 12`, a click repeats at
 * most three times at 60 ms, a scroll at most ten times at 10 ms, and
 * everything else is a single keystroke or button transition.
 */
export interface X11InputUnit {
  readonly args: ReadonlyArray<string>;
  readonly held: X11InputHeld;
}

/** Either the units one event becomes, or why it cannot become any. Each
    unit's `args` is the argument list after the `xdotool` executable. */
export type X11InputPlan =
  | { readonly _tag: "units"; readonly units: ReadonlyArray<X11InputUnit> }
  | { readonly _tag: "rejected"; readonly reason: string };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Display-relative point to root-window point, clamped onto the display so a
    stale client geometry can never park the pointer on another monitor. */
function rootPoint(
  surface: X11InputSurface,
  point: { readonly x: number; readonly y: number },
): readonly [string, string] {
  const x = clamp(Math.round(point.x), 0, Math.max(0, surface.widthPx - 1)) + surface.originX;
  const y = clamp(Math.round(point.y), 0, Math.max(0, surface.heightPx - 1)) + surface.originY;
  return [String(x), String(y)];
}

/** Wheel steps for a pixel delta. Browsers report a notch as ~40 px in the
    common case; anything smaller is still worth one step rather than nothing. */
export function scrollSteps(delta: number): number {
  return clamp(Math.round(Math.abs(delta) / 40) || 1, 1, 10);
}

/**
 * The X button for a wheel delta, in the contract's browser sign convention.
 *
 * X11 has no scroll axis: wheel motion is buttons 4/5 (up/down) and 6/7
 * (left/right). A positive `deltaY` moves the page toward its end, which is a
 * wheel-down, which is button 5.
 */
export function scrollButton(deltaX: number, deltaY: number): number | null {
  if (deltaY === 0 && deltaX === 0) return null;
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY > 0 ? 5 : 4;
  return deltaX > 0 ? 7 : 6;
}

/**
 * Longest text one `xdotool type` process is given, in UTF-16 units.
 *
 * Typing is paced (`--delay 12`), so a chunk costs about `12 ms` per character
 * and this bound is what a stop waits for: sixteen characters is under 200 ms
 * of typing, roughly a quarter second once the process has started. A
 * protocol-maximum 4096-character event is ~49 seconds, so it has to be split
 * either way; the size is set by how long a cancellation may take to land,
 * because the chunk in flight is never killed.
 */
export const TEXT_CHUNK_MAX_UNITS = 16;

/**
 * Splits text into `xdotool type` sized pieces on code point boundaries.
 *
 * Chunks are measured in UTF-16 units because that is what the protocol bounds,
 * but a chunk never ends between the halves of a surrogate pair: half an emoji
 * is not a character xdotool can type, and the other half would arrive as a
 * second broken one.
 */
export function splitTypedText(text: string): ReadonlyArray<string> {
  if (text.length <= TEXT_CHUNK_MAX_UNITS) return text.length === 0 ? [] : [text];
  const chunks: Array<string> = [];
  let current = "";
  for (const codePoint of text) {
    if (current.length + codePoint.length > TEXT_CHUNK_MAX_UNITS) {
      chunks.push(current);
      current = "";
    }
    current += codePoint;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function withoutLast<A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> {
  const index = values.lastIndexOf(value);
  return index < 0 ? values : [...values.slice(0, index), ...values.slice(index + 1)];
}

/**
 * The units that apply one input event, each carrying the held state the
 * display is left in once that unit's process has exited.
 *
 * One process at a time, run in order by the caller: two overlapping xdotool
 * runs race inside the X server (measured: "wsok" typed, "wosk" received). A
 * warp and the click that follows it stay together by being one invocation,
 * `mousemove X Y click ...`, which xdotool applies in the order written.
 *
 * An event that needs several processes hands back several units, and every
 * one of them says what is held afterwards. A modified click therefore holds
 * its own modifiers between its `keydown` and its `keyup`: they are only
 * transient to the event, but a cancellation can land between those two units,
 * and `release-all` can only let go of what somebody wrote down.
 *
 * `mousemove` never takes `--sync`. That flag waits for a pointer-motion event
 * confirming the new position, and when the pointer is already at X,Y the X
 * server sends no motion at all, so xdotool blocks forever (measured: `timeout
 * 2s xdotool mousemove --sync 700 230` exits 124 with the pointer already at
 * 700,230). A hover followed by a click on the same point is the ordinary case,
 * and it would wedge the whole ordered input path behind the session lock.
 */
export function xdotoolUnits(
  event: OpenbotComputerInputEvent,
  options: { readonly surface: X11InputSurface; readonly held: X11InputHeld },
): X11InputPlan {
  const { surface, held } = options;
  /** A unit that changes nothing about what is held. */
  const passive = (args: ReadonlyArray<string>): X11InputUnit => ({ args, held });
  switch (event.type) {
    case "move": {
      const [x, y] = rootPoint(surface, event.point);
      return { _tag: "units", units: [passive(["mousemove", x, y])] };
    }
    case "button": {
      const [x, y] = rootPoint(surface, event.point);
      const button = BUTTON_NUMBERS[event.button];
      const action = event.action === "down" ? "mousedown" : "mouseup";
      return {
        _tag: "units",
        units: [
          {
            args: ["mousemove", x, y, action, String(button)],
            held: {
              keys: held.keys,
              buttons:
                event.action === "down"
                  ? [...held.buttons, button]
                  : withoutLast(held.buttons, button),
            },
          },
        ],
      };
    }
    case "click": {
      const [x, y] = rootPoint(surface, event.point);
      const button = String(BUTTON_NUMBERS[event.button]);
      // At most three repeats 60 ms apart: the whole click is under 200 ms.
      const click = [
        "mousemove",
        x,
        y,
        "click",
        "--repeat",
        String(event.count),
        "--delay",
        "60",
        button,
      ];
      const modifiers = event.modifiers ?? [];
      if (modifiers.length === 0) return { _tag: "units", units: [passive(click)] };
      // A modified click brackets its own modifiers: they belong to this event
      // and are gone by the end of it, so the held state before and after is
      // the caller's. In between they are down, and tracked as such.
      const combination = modifiers.map((modifier) => MODIFIER_KEYSYMS[modifier]).join("+");
      const pressed: X11InputHeld = {
        keys: [...held.keys, combination],
        buttons: held.buttons,
      };
      return {
        _tag: "units",
        units: [
          { args: ["keydown", "--", combination], held: pressed },
          { args: click, held: pressed },
          { args: ["keyup", "--", combination], held },
        ],
      };
    }
    case "scroll": {
      const button = scrollButton(event.deltaX, event.deltaY);
      if (button === null) return { _tag: "rejected", reason: "scroll had no delta" };
      const [x, y] = rootPoint(surface, event.point);
      // `scrollSteps` caps at ten, 10 ms apart: the whole wheel run is ~100 ms.
      const steps = scrollSteps(
        Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX,
      );
      return {
        _tag: "units",
        units: [
          passive([
            "mousemove",
            x,
            y,
            "click",
            "--repeat",
            String(steps),
            "--delay",
            "10",
            String(button),
          ]),
        ],
      };
    }
    case "key": {
      const keysym = keysymForCode(event.key);
      if (keysym === null) return { _tag: "rejected", reason: `unknown key ${event.key}` };
      const combination = keyCombination(keysym, event.modifiers ?? []);
      const action = event.action === "down" ? "keydown" : "keyup";
      return {
        _tag: "units",
        units: [
          {
            args: [action, "--", combination],
            held: {
              keys:
                event.action === "down"
                  ? [...held.keys, combination]
                  : withoutLast(held.keys, combination),
              buttons: held.buttons,
            },
          },
        ],
      };
    }
    case "key-press": {
      const keysym = keysymForCode(event.key);
      if (keysym === null) return { _tag: "rejected", reason: `unknown key ${event.key}` };
      // `key` presses and releases inside the one process, which is safe only
      // because that process is never cut short.
      return {
        _tag: "units",
        units: [passive(["key", "--", keyCombination(keysym, event.modifiers ?? [])])],
      };
    }
    case "text":
      // One unit per chunk: the caller runs them in order, and a cancellation
      // lands between two of them rather than inside a character.
      return {
        _tag: "units",
        units: splitTypedText(event.text).map((chunk) =>
          passive(["type", "--delay", "12", "--", chunk]),
        ),
      };
    case "release-all": {
      // One release per unit, each folding off exactly what it let go of, so
      // an interrupted release-all leaves the rest still tracked and a later
      // one finishes the job.
      const units: Array<X11InputUnit> = [];
      let remaining = held;
      for (const combination of held.keys.toReversed()) {
        remaining = { keys: withoutLast(remaining.keys, combination), buttons: remaining.buttons };
        units.push({ args: ["keyup", "--", combination], held: remaining });
      }
      for (const button of held.buttons.toReversed()) {
        remaining = { keys: remaining.keys, buttons: withoutLast(remaining.buttons, button) };
        units.push({ args: ["mouseup", String(button)], held: remaining });
      }
      return { _tag: "units", units };
    }
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export interface X11DisplayName {
  /** Everything up to the screen suffix: ":0", "localhost:10". This is what
      `DISPLAY` must be set to for tools that address the whole server. */
  readonly base: string;
  readonly screen: number;
}

/**
 * Splits an X display name into server and screen.
 *
 * `DISPLAY` legitimately carries a screen suffix (`:0.1`), and appending
 * another one for ffmpeg's `-i` produces a name no X server answers to. Null
 * when the value is not an X display name at all.
 */
export function parseDisplayName(value: string): X11DisplayName | null {
  const text = value.trim();
  const colon = text.lastIndexOf(":");
  if (colon < 0 || colon === text.length - 1) return null;
  const suffix = text.slice(colon + 1);
  const dot = suffix.indexOf(".");
  const displayPart = dot < 0 ? suffix : suffix.slice(0, dot);
  const screenPart = dot < 0 ? "0" : suffix.slice(dot + 1);
  if (!/^\d+$/u.test(displayPart)) return null;
  const screen = Number.parseInt(screenPart, 10);
  return {
    base: `${text.slice(0, colon)}:${displayPart}`,
    screen: Number.isFinite(screen) ? screen : 0,
  };
}

export interface X11ScreenSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * The screen size out of `xdpyinfo`. Null when the output has no dimensions
 * line, which is also how a caller learns the display never answered.
 */
export function parseXdpyinfoScreen(text: string): X11ScreenSize | null {
  const match = /^\s*dimensions:\s+(\d+)x(\d+)\s+pixels/mu.exec(text);
  if (!match) return null;
  const widthPx = Number.parseInt(match[1] ?? "", 10);
  const heightPx = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return null;
  if (widthPx <= 0 || heightPx <= 0) return null;
  return { widthPx, heightPx };
}

export interface X11Monitor {
  readonly name: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly x: number;
  readonly y: number;
  readonly primary: boolean;
}

/**
 * The monitors of one X screen from `xrandr --listmonitors`.
 *
 * Each line looks like ` 0: +*eDP-1 1920/344x1080/193+0+0  eDP-1`: the `*`
 * marks the primary, the `/nnn` parts are physical millimetres we ignore, and
 * the trailing `+x+y` is the monitor's origin inside the root window. Returns
 * an empty array when nothing parses, so a caller falls back to the whole
 * screen rather than inventing a layout.
 */
export function parseXrandrMonitors(text: string): ReadonlyArray<X11Monitor> {
  const monitors: Array<X11Monitor> = [];
  const line =
    /^\s*\d+:\s+\+(?<primary>\*?)(?<name>\S+)\s+(?<width>\d+)(?:\/\d+)?x(?<height>\d+)(?:\/\d+)?\+(?<x>-?\d+)\+(?<y>-?\d+)/u;
  for (const raw of text.split("\n")) {
    const match = line.exec(raw);
    const groups = match?.groups;
    if (!groups) continue;
    const widthPx = Number.parseInt(groups.width ?? "", 10);
    const heightPx = Number.parseInt(groups.height ?? "", 10);
    const x = Number.parseInt(groups.x ?? "", 10);
    const y = Number.parseInt(groups.y ?? "", 10);
    if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (widthPx <= 0 || heightPx <= 0) continue;
    monitors.push({
      name: groups.name ?? "",
      widthPx,
      heightPx,
      x,
      y,
      primary: groups.primary === "*",
    });
  }
  return monitors;
}

export interface X11WindowGeometry {
  /** Root-window coordinates: what the capture of that screen actually shows. */
  readonly x: number;
  readonly y: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * `xwininfo -id <xid>` output, which reports a window's absolute upper-left
 * corner in the root window plus its size.
 *
 * xwininfo rather than `xdotool getwindowgeometry --shell`: under a reparenting
 * window manager xdotool adds the frame offset to a position that already
 * includes it, so an Openbox window whose contents are at 41,140 is reported at
 * 42,160 and every coordinate the UI derives from it is wrong (measured on a
 * real Openbox session). Null when the four values are not all present, because
 * a partial frame is a lie the UI cannot detect.
 */
export function parseXwininfoGeometry(text: string): X11WindowGeometry | null {
  const read = (pattern: RegExp): number | null => {
    const match = pattern.exec(text);
    const parsed = Number.parseInt(match?.[1] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const x = read(/^\s*Absolute upper-left X:\s*(-?\d+)\s*$/mu);
  const y = read(/^\s*Absolute upper-left Y:\s*(-?\d+)\s*$/mu);
  const widthPx = read(/^\s*Width:\s*(\d+)\s*$/mu);
  const heightPx = read(/^\s*Height:\s*(\d+)\s*$/mu);
  if (x === null || y === null || widthPx === null || heightPx === null) return null;
  return { x, y, widthPx, heightPx };
}
