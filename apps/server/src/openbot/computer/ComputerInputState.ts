import type {
  OpenbotComputerInputEvent,
  OpenbotComputerMouseButton,
  OpenbotComputerPoint,
} from "@t3tools/contracts";

/**
 * What one input source is currently holding down on the shared desktop.
 *
 * The desktop has no undo for a stuck key: a viewer whose laptop lid closes
 * mid-drag leaves the mouse button down for whoever sits at the machine next.
 * So every delivered event is folded into this state, and when a source
 * disconnects or loses the lease the session sends `releaseEventsFor` to put
 * the desktop back the way it found it.
 *
 * Pure and platform neutral: it only knows the contract's event vocabulary.
 */
export interface ComputerInputState {
  /** Mouse buttons held down, in press order. */
  readonly buttons: ReadonlyArray<OpenbotComputerMouseButton>;
  /** Keys held down as W3C `code` values, in press order. */
  readonly keys: ReadonlyArray<string>;
  /**
   * Where the pointer was last put. A button-up needs a point, and the only
   * honest one is where the press happened.
   */
  readonly point: OpenbotComputerPoint;
}

/** A source that has sent nothing yet: nothing pressed, pointer at the origin. */
export const emptyComputerInputState: ComputerInputState = {
  buttons: [],
  keys: [],
  point: { x: 0, y: 0 },
};

const withButton = (
  state: ComputerInputState,
  button: OpenbotComputerMouseButton,
  action: "down" | "up",
  point: OpenbotComputerPoint,
): ComputerInputState => ({
  buttons:
    action === "down"
      ? state.buttons.includes(button)
        ? state.buttons
        : [...state.buttons, button]
      : state.buttons.filter((held) => held !== button),
  keys: state.keys,
  point,
});

const withKey = (
  state: ComputerInputState,
  key: string,
  action: "down" | "up",
): ComputerInputState => ({
  buttons: state.buttons,
  keys:
    action === "down"
      ? state.keys.includes(key)
        ? state.keys
        : [...state.keys, key]
      : state.keys.filter((held) => held !== key),
  point: state.point,
});

/**
 * Folds one delivered event into the source's held state.
 *
 * Only events the backend actually delivered belong here: applying a rejected
 * press would make the session release a button nobody is holding.
 */
export function applyComputerInputEvent(
  state: ComputerInputState,
  event: OpenbotComputerInputEvent,
): ComputerInputState {
  switch (event.type) {
    case "move":
      return { ...state, point: event.point };
    case "button":
      return withButton(state, event.button, event.action, event.point);
    case "click":
      // A click is a self-contained press and release, so it moves the pointer
      // without leaving anything held.
      return { ...state, point: event.point };
    case "scroll":
      return { ...state, point: event.point };
    case "key":
      return withKey(state, event.key, event.action);
    case "key-press":
      return state;
    case "text":
      return state;
    case "release-all":
      return { buttons: [], keys: [], point: state.point };
  }
}

/** Folds a delivered batch in order. */
export function applyComputerInputEvents(
  state: ComputerInputState,
  events: Iterable<OpenbotComputerInputEvent>,
): ComputerInputState {
  let next = state;
  for (const event of events) next = applyComputerInputEvent(next, event);
  return next;
}

/** Whether this source is holding anything the desktop would keep held. */
export function isComputerInputStateIdle(state: ComputerInputState): boolean {
  return state.buttons.length === 0 && state.keys.length === 0;
}

/**
 * The events that put the desktop back to nothing-held for this source, in
 * release order (keys first so a modifier is not stranded under a drag), or an
 * empty array when the source is already idle.
 *
 * Explicit up events rather than a single `release-all` because a backend that
 * cannot express `release-all` can still deliver these, and because the events
 * name exactly what the session believes is held.
 */
export function releaseEventsFor(
  state: ComputerInputState,
): ReadonlyArray<OpenbotComputerInputEvent> {
  if (isComputerInputStateIdle(state)) return [];
  return [
    ...state.keys.map(
      (key) => ({ type: "key", key, action: "up" }) satisfies OpenbotComputerInputEvent,
    ),
    ...state.buttons.map(
      (button) =>
        ({
          type: "button",
          button,
          action: "up",
          point: state.point,
        }) satisfies OpenbotComputerInputEvent,
    ),
  ];
}

/** A batch with redundant pointer moves removed, next to where each surviving
    event sat in the batch the caller sent. */
export interface CoalescedComputerInput {
  readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
  /**
   * `sourceIndices[i]` is the position of `events[i]` in the original batch.
   * The backend reports rejections by index into what it was handed, and a
   * client acknowledgement has to name the event the client actually sent.
   */
  readonly sourceIndices: ReadonlyArray<number>;
}

/**
 * Drops every `move` but the last of each consecutive run.
 *
 * A pointer that travelled through twenty positions since the last batch only
 * needs its final one: the intermediate warps cost a backend round trip each
 * and are invisible. Runs are collapsed rather than all moves, because a move
 * before a button-down is what positions that press.
 */
export function coalesceComputerInputMoves(
  events: ReadonlyArray<OpenbotComputerInputEvent>,
): CoalescedComputerInput {
  const coalesced: Array<OpenbotComputerInputEvent> = [];
  const sourceIndices: Array<number> = [];
  events.forEach((event, index) => {
    if (event.type === "move" && coalesced.at(-1)?.type === "move") {
      coalesced[coalesced.length - 1] = event;
      sourceIndices[sourceIndices.length - 1] = index;
      return;
    }
    coalesced.push(event);
    sourceIndices.push(index);
  });
  return { events: coalesced, sourceIndices };
}
