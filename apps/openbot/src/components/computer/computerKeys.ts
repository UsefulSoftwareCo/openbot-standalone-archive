import type {
  OpenbotComputerInputEvent,
  OpenbotComputerModifier,
  OpenbotComputerMouseButton,
} from "@t3tools/contracts";

/**
 * Browser keyboard events translated into host input.
 *
 * Two channels, the way remote desktop clients have always split them: a
 * character the user typed travels as `text` so the host reproduces it under
 * whatever layout it has, while a physical key that means an action (Enter,
 * arrows, Cmd-S) travels as `key` named by its layout-independent
 * `KeyboardEvent.code`. Sending both for the same keystroke types the
 * character twice, so exactly one of them claims each event, and the caller
 * calls `preventDefault` precisely when the key channel claimed it.
 *
 * The held set exists so nothing stays pressed on a desktop somebody else is
 * looking at: a key the client never sent down is never sent up, and every
 * blur releases what is left.
 */

/** The parts of a `KeyboardEvent` this mapping reads. */
export interface ComputerKeyboardEvent {
  readonly code: string;
  readonly key: string;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export interface ComputerKeyInput {
  readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
  /** The codes still pressed after this event. */
  readonly held: ReadonlySet<string>;
  /** True when the key channel claimed the event and the browser must not act on it. */
  readonly preventDefault: boolean;
}

/** The modifiers physically down at the moment of the event. */
export function eventModifiers(
  event: ComputerKeyboardEvent,
): ReadonlyArray<OpenbotComputerModifier> {
  const modifiers: Array<OpenbotComputerModifier> = [];
  if (event.shiftKey) modifiers.push("shift");
  if (event.ctrlKey) modifiers.push("control");
  if (event.altKey) modifiers.push("alt");
  if (event.metaKey) modifiers.push("meta");
  return modifiers;
}

/** Keys an IME owns: leaving them alone is what makes composition work. */
const COMPOSITION_KEYS = new Set(["Dead", "Process", "Unidentified"]);

/**
 * Whether this keystroke is an action rather than a character. Anything held
 * with a non-shift modifier is an action too: no host layout turns Cmd-S into
 * a character, and the textarea would swallow it.
 */
export function handledAsKey(event: ComputerKeyboardEvent): boolean {
  if (event.code.length === 0) return false;
  if (COMPOSITION_KEYS.has(event.key)) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return true;
  return event.key.length !== 1;
}

function withModifiers(
  event: ComputerKeyboardEvent,
  action: "down" | "up",
): OpenbotComputerInputEvent {
  const modifiers = eventModifiers(event);
  return modifiers.length === 0
    ? { type: "key", key: event.code, action }
    : { type: "key", key: event.code, action, modifiers };
}

function unchanged(held: ReadonlySet<string>, preventDefault: boolean): ComputerKeyInput {
  return { events: [], held, preventDefault };
}

/**
 * What a `keydown` sends. A repeat, or a key the host already believes is
 * down, sends nothing: the host repeats on its own, and a second down for a
 * key that never came up is how a modifier gets stuck.
 */
export function keyDownInput(
  event: ComputerKeyboardEvent,
  held: ReadonlySet<string>,
): ComputerKeyInput {
  if (!handledAsKey(event)) return unchanged(held, false);
  if (event.repeat || held.has(event.code)) return unchanged(held, true);
  const next = new Set(held);
  next.add(event.code);
  return { events: [withModifiers(event, "down")], held: next, preventDefault: true };
}

/** What a `keyup` sends. Only a key this client pressed is released. */
export function keyUpInput(
  event: ComputerKeyboardEvent,
  held: ReadonlySet<string>,
): ComputerKeyInput {
  if (!held.has(event.code)) return unchanged(held, handledAsKey(event));
  const next = new Set(held);
  next.delete(event.code);
  return { events: [withModifiers(event, "up")], held: next, preventDefault: true };
}

/**
 * Let go of everything. Sent on blur, on lost pointer capture, on disconnect
 * and when control is lost, so neither a modifier the browser stopped
 * reporting nor a button held through a drag stays down on a desktop the user
 * can no longer see. Buttons count: a mouse-only drag holds nothing on the
 * keyboard and still leaves the host with a button pressed.
 */
export function releaseEvents(
  heldKeys: ReadonlySet<string>,
  heldButtons: ReadonlySet<OpenbotComputerMouseButton>,
): ReadonlyArray<OpenbotComputerInputEvent> {
  return heldKeys.size === 0 && heldButtons.size === 0 ? [] : [{ type: "release-all" }];
}

/** What this client is holding down on the host right now. */
export interface HeldInput {
  readonly heldKeys: ReadonlySet<string>;
  readonly heldButtons: ReadonlySet<OpenbotComputerMouseButton>;
}

/** What a viewer must do about the host when the page's visibility changes. */
export interface ViewerRelease {
  readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
  /** Whether to hand the input lease back so somebody else can take it. */
  readonly releaseControl: boolean;
}

/**
 * What a viewer owes the host when the page stops being visible. A hidden tab
 * holding the lease locks everyone else out of a desktop nobody is watching,
 * so it gives the lease back and releases anything it was holding down. A
 * visible page owes nothing.
 */
export function hiddenViewerRelease(
  viewer: HeldInput & { readonly visible: boolean; readonly controlling: boolean },
): ViewerRelease {
  if (viewer.visible) return { events: [], releaseControl: false };
  return {
    events: releaseEvents(viewer.heldKeys, viewer.heldButtons),
    releaseControl: viewer.controlling,
  };
}

/** The maximum a single `text` event carries, per the contract. */
const MAX_TEXT_LENGTH = 4096;

/** Whether cutting `text` at `index` would split an astral character in half. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Characters from the hidden textarea's `input` or `compositionend`. A
 * deletion reports no data, and has already travelled as a Backspace key.
 *
 * A paste is as long as the user's clipboard, so this chunks rather than
 * truncates: the contract caps one `text` event at 4096 UTF-16 code units,
 * and half a surrogate pair is not a character, so a chunk that would end
 * between the two halves ends one unit earlier instead.
 */
export function textEvents(
  data: string | null | undefined,
): ReadonlyArray<OpenbotComputerInputEvent> {
  if (data === null || data === undefined || data.length === 0) return [];
  const events: Array<OpenbotComputerInputEvent> = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + MAX_TEXT_LENGTH, data.length);
    if (end < data.length && splitsSurrogatePair(data, end)) end -= 1;
    events.push({ type: "text", text: data.slice(start, end) });
    start = end;
  }
  return events;
}
