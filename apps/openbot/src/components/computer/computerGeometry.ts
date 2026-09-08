/**
 * Where the remote frame sits inside the stage, and how a browser pointer
 * lands on the host's screen.
 *
 * Every number the viewer sends the host is a display pixel, so the mapping
 * between CSS pixels and display pixels is the one piece of this feature that
 * has to be exactly right: a half-scaled click is a click on the wrong button.
 * It lives here, pure, instead of being spread across pointer handlers.
 */

/** "fit" scales the frame to the stage; "native" shows one frame pixel per CSS pixel. */
export type ComputerViewMode = "fit" | "native";

export interface ComputerStageSize {
  readonly width: number;
  readonly height: number;
}

export interface ComputerFrameSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface ComputerGeometry {
  /** CSS pixels per frame pixel. */
  readonly scale: number;
  /** CSS offset from the stage's top-left to the image's top-left. Negative in
      "native" mode when the frame is larger than the stage. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
}

const EMPTY_GEOMETRY: ComputerGeometry = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  cssWidth: 0,
  cssHeight: 0,
};

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Lays the frame out in the stage, centred on both axes. A stage or frame
 * without a positive size yields a zero-sized geometry rather than an
 * `Infinity` scale, so a canvas measured before layout draws nothing instead
 * of drawing wrong.
 */
export function computerGeometry(
  stage: ComputerStageSize,
  frame: ComputerFrameSize,
  mode: ComputerViewMode,
): ComputerGeometry {
  if (
    !isPositive(stage.width) ||
    !isPositive(stage.height) ||
    !isPositive(frame.widthPx) ||
    !isPositive(frame.heightPx)
  ) {
    return EMPTY_GEOMETRY;
  }
  const scale =
    mode === "native" ? 1 : Math.min(stage.width / frame.widthPx, stage.height / frame.heightPx);
  const cssWidth = frame.widthPx * scale;
  const cssHeight = frame.heightPx * scale;
  return {
    scale,
    offsetX: (stage.width - cssWidth) / 2,
    offsetY: (stage.height - cssHeight) / 2,
    cssWidth,
    cssHeight,
  };
}

export interface ComputerStageRect {
  readonly left: number;
  readonly top: number;
}

export interface ComputerDisplaySize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface ComputerDisplayPoint {
  readonly x: number;
  readonly y: number;
}

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(value, 0), maximum);
}

/**
 * The display pixel under a browser pointer, or null when the pointer is over
 * the letterbox rather than the image. The frame may be a downscaled capture,
 * so the mapping goes through the image's CSS box to the display's own pixel
 * space rather than assuming the two match.
 */
export function stageToDisplayPoint(
  clientX: number,
  clientY: number,
  rect: ComputerStageRect,
  geometry: ComputerGeometry,
  display: ComputerDisplaySize,
): ComputerDisplayPoint | null {
  if (geometry.cssWidth <= 0 || geometry.cssHeight <= 0) return null;
  const fractionX = (clientX - rect.left - geometry.offsetX) / geometry.cssWidth;
  const fractionY = (clientY - rect.top - geometry.offsetY) / geometry.cssHeight;
  if (fractionX < 0 || fractionX > 1 || fractionY < 0 || fractionY > 1) return null;
  return {
    x: Math.round(clamp(fractionX * display.widthPx, Math.max(display.widthPx - 1, 0))),
    y: Math.round(clamp(fractionY * display.heightPx, Math.max(display.heightPx - 1, 0))),
  };
}

/** Chrome's historical line height, and what every wheel normalizer uses. */
const PIXELS_PER_LINE = 16;

export interface WheelDeltaInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
}

/**
 * Wheel deltas in pixels, keeping the browser's sign convention. Firefox
 * reports lines and a trackpad-less mouse can report pages, so the host would
 * otherwise receive a scroll three orders of magnitude too small.
 */
export function normalizeWheelDelta(
  event: WheelDeltaInput,
  stageHeight: number,
): { readonly deltaX: number; readonly deltaY: number } {
  const page = isPositive(stageHeight) ? stageHeight : 0;
  const factor = event.deltaMode === 1 ? PIXELS_PER_LINE : event.deltaMode === 2 ? page : 1;
  return { deltaX: event.deltaX * factor, deltaY: event.deltaY * factor };
}
