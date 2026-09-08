import { expect, it } from "@effect/vitest";
import type { OpenbotComputerInputEvent } from "@t3tools/contracts";
import { describe } from "vite-plus/test";

import {
  applyComputerInputEvents,
  coalesceComputerInputMoves,
  emptyComputerInputState,
  isComputerInputStateIdle,
  releaseEventsFor,
} from "./ComputerInputState.ts";

const at = (x: number, y: number) => ({ x, y });

describe("ComputerInputState", () => {
  it("releases a drag with the button up at the point it was pressed", () => {
    const state = applyComputerInputEvents(emptyComputerInputState, [
      { type: "move", point: at(10, 10) },
      { type: "button", button: "left", action: "down", point: at(10, 10) },
      { type: "move", point: at(80, 40) },
    ]);
    expect(isComputerInputStateIdle(state)).toBe(false);
    expect(releaseEventsFor(state)).toEqual([
      { type: "button", button: "left", action: "up", point: at(80, 40) },
    ]);
  });

  it("releases held keys before held buttons so no modifier is stranded", () => {
    const state = applyComputerInputEvents(emptyComputerInputState, [
      { type: "key", key: "ShiftLeft", action: "down" },
      { type: "key", key: "KeyA", action: "down" },
      { type: "button", button: "right", action: "down", point: at(5, 5) },
    ]);
    expect(releaseEventsFor(state)).toEqual([
      { type: "key", key: "ShiftLeft", action: "up" },
      { type: "key", key: "KeyA", action: "up" },
      { type: "button", button: "right", action: "up", point: at(5, 5) },
    ]);
  });

  it("has nothing to release once every press was matched by an up", () => {
    const state = applyComputerInputEvents(emptyComputerInputState, [
      { type: "button", button: "left", action: "down", point: at(1, 1) },
      { type: "key", key: "MetaLeft", action: "down" },
      { type: "button", button: "left", action: "up", point: at(2, 2) },
      { type: "key", key: "MetaLeft", action: "up" },
    ]);
    expect(isComputerInputStateIdle(state)).toBe(true);
    expect(releaseEventsFor(state)).toEqual([]);
  });

  it("treats self-contained events as leaving nothing held", () => {
    const state = applyComputerInputEvents(emptyComputerInputState, [
      { type: "click", button: "left", count: 2, point: at(30, 30) },
      { type: "key-press", key: "Enter" },
      { type: "text", text: "hello" },
      { type: "scroll", point: at(40, 40), deltaX: 0, deltaY: 120 },
    ]);
    expect(isComputerInputStateIdle(state)).toBe(true);
    expect(state.point).toEqual(at(40, 40));
  });

  it("forgets everything held after a release-all", () => {
    const state = applyComputerInputEvents(emptyComputerInputState, [
      { type: "button", button: "middle", action: "down", point: at(7, 7) },
      { type: "key", key: "ControlLeft", action: "down" },
      { type: "release-all" },
    ]);
    expect(releaseEventsFor(state)).toEqual([]);
    expect(state.point).toEqual(at(7, 7));
  });

  it("does not double-count a key or button already held", () => {
    const state = applyComputerInputEvents(emptyComputerInputState, [
      { type: "key", key: "KeyA", action: "down" },
      { type: "key", key: "KeyA", action: "down" },
      { type: "button", button: "left", action: "down", point: at(0, 0) },
      { type: "button", button: "left", action: "down", point: at(0, 0) },
    ]);
    expect(state.keys).toEqual(["KeyA"]);
    expect(state.buttons).toEqual(["left"]);
  });

  it("keeps only the last move of each consecutive run", () => {
    const events: ReadonlyArray<OpenbotComputerInputEvent> = [
      { type: "move", point: at(1, 1) },
      { type: "move", point: at(2, 2) },
      { type: "move", point: at(3, 3) },
      { type: "button", button: "left", action: "down", point: at(3, 3) },
      { type: "move", point: at(9, 9) },
      { type: "move", point: at(10, 10) },
      { type: "button", button: "left", action: "up", point: at(10, 10) },
    ];
    expect(coalesceComputerInputMoves(events)).toEqual({
      events: [
        { type: "move", point: at(3, 3) },
        { type: "button", button: "left", action: "down", point: at(3, 3) },
        { type: "move", point: at(10, 10) },
        { type: "button", button: "left", action: "up", point: at(10, 10) },
      ],
      // The surviving move is the last one of its run, so an ack points at the
      // event the client actually sent.
      sourceIndices: [2, 3, 5, 6],
    });
  });

  it("keeps every event when there is nothing to coalesce", () => {
    const events: ReadonlyArray<OpenbotComputerInputEvent> = [
      { type: "move", point: at(1, 1) },
      { type: "key-press", key: "Enter" },
      { type: "move", point: at(2, 2) },
    ];
    expect(coalesceComputerInputMoves(events)).toEqual({ events, sourceIndices: [0, 1, 2] });
  });

  it("coalescing never changes what ends up held", () => {
    const events: ReadonlyArray<OpenbotComputerInputEvent> = [
      { type: "move", point: at(1, 1) },
      { type: "move", point: at(4, 4) },
      { type: "button", button: "left", action: "down", point: at(4, 4) },
      { type: "move", point: at(6, 6) },
      { type: "move", point: at(8, 8) },
      { type: "key", key: "ShiftLeft", action: "down" },
    ];
    expect(
      applyComputerInputEvents(emptyComputerInputState, coalesceComputerInputMoves(events).events),
    ).toEqual(applyComputerInputEvents(emptyComputerInputState, events));
  });
});
