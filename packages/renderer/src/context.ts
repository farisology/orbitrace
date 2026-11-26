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

/** Everything the engine takes from its environment. `createOrrery` uses the browser's. */
export interface OrreryEnvironment {
  /** Schedule one frame. Default `requestAnimationFrame`. */
  requestFrame(callback: (now: number) => void): number;
  /** Cancel a scheduled frame. Default `cancelAnimationFrame`. */
  cancelFrame(handle: number): void;
  /** The user's reduced-motion preference, read once at creation. */
  prefersReducedMotion(): boolean;
  /** Default device pixel ratio. */
  devicePixelRatio(): number;
  /** A small offscreen surface for a glow sprite, or `null` to draw without sprites. */
  createSurface(width: number, height: number): SpriteSurface | null;
}
