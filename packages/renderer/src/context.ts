/**
 * The narrow surfaces the engine needs from the browser, so tests can pass recording mocks
 * and a host can inject its own frame scheduler.
 */

/** The part of `CanvasRenderingContext2D` the drawing code uses. */
export type DrawContext = Pick<
  CanvasRenderingContext2D,
  | "globalAlpha"
  | "globalCompositeOperation"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineJoin"
  | "lineCap"
  | "lineDashOffset"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "setTransform"
  | "save"
  | "restore"
  | "translate"
  | "rotate"
  | "setLineDash"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "quadraticCurveTo"
  | "rect"
  | "fill"
  | "stroke"
  | "fillRect"
  | "clearRect"
  | "fillText"
  | "measureText"
  | "drawImage"
  | "createRadialGradient"
  | "createLinearGradient"
>;

/** The part of a path API used to trace a node outline. */
export type PathContext = Pick<
  CanvasRenderingContext2D,
  "beginPath" | "moveTo" | "lineTo" | "closePath" | "arc"
>;

/** A drawable surface the engine can paint glow sprites into once and reuse. */
export interface SpriteSurface {
  readonly image: CanvasImageSource;
  readonly context: DrawContext;
}

/**
 * Everything the engine takes from its environment. Declared in the contract (`api.ts`, #70) and
 * re-exported here so existing imports keep working.
 */
export type { OrreryEnvironment } from "./api.js";
