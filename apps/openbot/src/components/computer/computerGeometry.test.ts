import { describe, expect, it } from "@effect/vitest";

import { computerGeometry, normalizeWheelDelta, stageToDisplayPoint } from "./computerGeometry";

const stage = { width: 1000, height: 500 };
const frame = { widthPx: 800, heightPx: 600 };

describe("computerGeometry", () => {
  it("fits the frame inside the stage and centres the letterbox", () => {
    const geometry = computerGeometry(stage, frame, "fit");
    // Height is the binding constraint: 500 / 600.
    expect(geometry.scale).toBeCloseTo(500 / 600);
    expect(geometry.cssHeight).toBeCloseTo(500);
    expect(geometry.cssWidth).toBeCloseTo(800 * (500 / 600));
    expect(geometry.offsetY).toBeCloseTo(0);
    expect(geometry.offsetX).toBeCloseTo((1000 - 800 * (500 / 600)) / 2);
  });

  it("draws one frame pixel per CSS pixel in native mode, overflowing when larger", () => {
    const geometry = computerGeometry(stage, frame, "native");
    expect(geometry.scale).toBe(1);
    expect(geometry.cssWidth).toBe(800);
    expect(geometry.cssHeight).toBe(600);
    expect(geometry.offsetX).toBe(100);
    expect(geometry.offsetY).toBe(-50);
  });

  it("draws nothing rather than at an infinite scale before layout", () => {
    expect(computerGeometry({ width: 0, height: 0 }, frame, "fit")).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      cssWidth: 0,
      cssHeight: 0,
    });
    expect(computerGeometry(stage, { widthPx: 0, heightPx: 0 }, "fit").cssWidth).toBe(0);
  });
});

describe("stageToDisplayPoint", () => {
  const rect = { left: 20, top: 10 };
  const display = { widthPx: 2560, heightPx: 1920 };
  // A capture downscaled to 800×600 of a 2560×1920 display, fit into the stage.
  const geometry = computerGeometry(stage, frame, "fit");

  it("maps a click to the display pixel under it, through the capture downscale", () => {
    const centre = stageToDisplayPoint(
      rect.left + geometry.offsetX + geometry.cssWidth / 2,
      rect.top + geometry.offsetY + geometry.cssHeight / 2,
      rect,
      geometry,
      display,
    );
    expect(centre).toEqual({ x: 1280, y: 960 });
  });

  it("clamps the far edge inside the display rather than one pixel past it", () => {
    expect(
      stageToDisplayPoint(
        rect.left + geometry.offsetX + geometry.cssWidth,
        rect.top + geometry.offsetY + geometry.cssHeight,
        rect,
        geometry,
        display,
      ),
    ).toEqual({ x: 2559, y: 1919 });
  });

  it("returns nothing for the letterbox around the image", () => {
    expect(stageToDisplayPoint(rect.left + 1, rect.top + 200, rect, geometry, display)).toBeNull();
    expect(
      stageToDisplayPoint(
        rect.left + geometry.offsetX + geometry.cssWidth + 5,
        rect.top + geometry.offsetY,
        rect,
        geometry,
        display,
      ),
    ).toBeNull();
  });

  it("returns nothing when there is no image yet", () => {
    expect(
      stageToDisplayPoint(
        100,
        100,
        rect,
        { scale: 1, offsetX: 0, offsetY: 0, cssWidth: 0, cssHeight: 0 },
        display,
      ),
    ).toBeNull();
  });
});

describe("normalizeWheelDelta", () => {
  it("passes pixel deltas through unchanged", () => {
    expect(normalizeWheelDelta({ deltaX: -3, deltaY: 120, deltaMode: 0 }, 500)).toEqual({
      deltaX: -3,
      deltaY: 120,
    });
  });

  it("turns Firefox's line deltas into pixels", () => {
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toEqual({
      deltaX: 0,
      deltaY: 48,
    });
  });

  it("turns page deltas into one stage of scroll", () => {
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 500)).toEqual({
      deltaX: 0,
      deltaY: -500,
    });
  });
});
