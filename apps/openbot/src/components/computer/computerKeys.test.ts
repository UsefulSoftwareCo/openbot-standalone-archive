import { describe, expect, it } from "@effect/vitest";

import type { OpenbotComputerMouseButton } from "@t3tools/contracts";

import {
  type ComputerKeyboardEvent,
  eventModifiers,
  handledAsKey,
  hiddenViewerRelease,
  keyDownInput,
  keyUpInput,
  releaseEvents,
  textEvents,
} from "./computerKeys";

const NOTHING_HELD: ReadonlySet<OpenbotComputerMouseButton> = new Set();

function press(overrides: Partial<ComputerKeyboardEvent>): ComputerKeyboardEvent {
  return {
    code: "KeyA",
    key: "a",
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("handledAsKey", () => {
  it("leaves plain characters to the text channel", () => {
    expect(handledAsKey(press({}))).toBe(false);
    expect(handledAsKey(press({ code: "KeyA", key: "A", shiftKey: true }))).toBe(false);
    expect(handledAsKey(press({ code: "Space", key: " " }))).toBe(false);
  });

  it("claims action keys", () => {
    expect(handledAsKey(press({ code: "Enter", key: "Enter" }))).toBe(true);
    expect(handledAsKey(press({ code: "Backspace", key: "Backspace" }))).toBe(true);
    expect(handledAsKey(press({ code: "ArrowLeft", key: "ArrowLeft" }))).toBe(true);
    expect(handledAsKey(press({ code: "F5", key: "F5" }))).toBe(true);
    expect(handledAsKey(press({ code: "MetaLeft", key: "Meta", metaKey: true }))).toBe(true);
  });

  it("claims a character held with a command modifier", () => {
    expect(handledAsKey(press({ metaKey: true }))).toBe(true);
    expect(handledAsKey(press({ ctrlKey: true }))).toBe(true);
    expect(handledAsKey(press({ altKey: true }))).toBe(true);
  });

  it("leaves an IME's own keys alone", () => {
    expect(handledAsKey(press({ code: "KeyE", key: "Dead" }))).toBe(false);
    expect(handledAsKey(press({ code: "", key: "Unidentified" }))).toBe(false);
  });
});

describe("eventModifiers", () => {
  it("reports every modifier physically down", () => {
    expect(eventModifiers(press({ shiftKey: true, metaKey: true }))).toEqual(["shift", "meta"]);
    expect(eventModifiers(press({}))).toEqual([]);
  });
});

describe("keyDownInput", () => {
  it("sends the physical code with the modifiers held at the time", () => {
    const result = keyDownInput(press({ code: "KeyS", key: "s", metaKey: true }), new Set());
    expect(result.events).toEqual([
      { type: "key", key: "KeyS", action: "down", modifiers: ["meta"] },
    ]);
    expect(result.preventDefault).toBe(true);
    expect([...result.held]).toEqual(["KeyS"]);
  });

  it("sends nothing for a character, and lets the browser produce its text", () => {
    const result = keyDownInput(press({}), new Set());
    expect(result.events).toEqual([]);
    expect(result.preventDefault).toBe(false);
    expect(result.held.size).toBe(0);
  });

  it("swallows auto-repeat instead of re-pressing a held key", () => {
    const held = new Set(["ArrowDown"]);
    const result = keyDownInput(press({ code: "ArrowDown", key: "ArrowDown", repeat: true }), held);
    expect(result.events).toEqual([]);
    expect(result.preventDefault).toBe(true);
    expect(result.held).toBe(held);
  });

  it("does not press a key the host already believes is down", () => {
    expect(
      keyDownInput(
        press({ code: "ShiftLeft", key: "Shift", shiftKey: true }),
        new Set(["ShiftLeft"]),
      ).events,
    ).toEqual([]);
  });
});

describe("keyUpInput", () => {
  it("releases a key this client pressed and forgets it", () => {
    const result = keyUpInput(press({ code: "Enter", key: "Enter" }), new Set(["Enter", "KeyQ"]));
    expect(result.events).toEqual([{ type: "key", key: "Enter", action: "up" }]);
    expect([...result.held]).toEqual(["KeyQ"]);
  });

  it("never releases a key it never pressed", () => {
    const result = keyUpInput(press({}), new Set());
    expect(result.events).toEqual([]);
    expect(result.preventDefault).toBe(false);
  });
});

describe("releaseEvents", () => {
  it("lets go of everything only when something is held", () => {
    expect(releaseEvents(new Set(["MetaLeft"]), NOTHING_HELD)).toEqual([{ type: "release-all" }]);
    expect(releaseEvents(new Set(), NOTHING_HELD)).toEqual([]);
  });

  it("releases a mouse-only drag, which holds no keys at all", () => {
    expect(releaseEvents(new Set(), new Set<OpenbotComputerMouseButton>(["left"]))).toEqual([
      { type: "release-all" },
    ]);
  });
});

describe("hiddenViewerRelease", () => {
  it("owes the host nothing while the page is visible", () => {
    expect(
      hiddenViewerRelease({
        visible: true,
        controlling: true,
        heldKeys: new Set(["ShiftLeft"]),
        heldButtons: new Set<OpenbotComputerMouseButton>(["left"]),
      }),
    ).toEqual({ events: [], releaseControl: false });
  });

  it("gives back the lease and what it was holding when the page hides", () => {
    expect(
      hiddenViewerRelease({
        visible: false,
        controlling: true,
        heldKeys: new Set(),
        heldButtons: new Set<OpenbotComputerMouseButton>(["left"]),
      }),
    ).toEqual({ events: [{ type: "release-all" }], releaseControl: true });
  });

  it("does not release a lease it never held", () => {
    expect(
      hiddenViewerRelease({
        visible: false,
        controlling: false,
        heldKeys: new Set(),
        heldButtons: NOTHING_HELD,
      }),
    ).toEqual({ events: [], releaseControl: false });
  });
});

/** The text each event carries, failing loudly if anything else was produced. */
function textChunks(data: string): ReadonlyArray<string> {
  return textEvents(data).map((event) => {
    if (event.type !== "text") throw new Error(`textEvents produced a ${event.type} event`);
    return event.text;
  });
}

/** True when a chunk begins or ends with half of an astral character. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    }
  }
  return false;
}

describe("textEvents", () => {
  it("carries typed characters", () => {
    expect(textEvents("héllo")).toEqual([{ type: "text", text: "héllo" }]);
  });

  it("sends nothing for a deletion, which travelled as a key", () => {
    expect(textEvents(null)).toEqual([]);
    expect(textEvents("")).toEqual([]);
  });

  it("splits a long paste into bounded events instead of losing the rest", () => {
    const pasted = "x".repeat(10_000);
    const chunks = textChunks(pasted);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4096, 4096, 1808]);
    expect(chunks.join("")).toBe(pasted);
  });

  it("never cuts a surrogate pair in half", () => {
    // One leading code unit puts the 4096 boundary between the two halves of
    // an emoji, which is the only case the naive slice gets wrong.
    const pasted = `a${"😀".repeat(2050)}`;
    const chunks = textChunks(pasted);
    expect(chunks.join("")).toBe(pasted);
    expect(chunks[0]?.length).toBe(4095);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(hasLoneSurrogate(chunk)).toBe(false);
    }
  });
});
