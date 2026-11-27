/**
 * A 2D context that does nothing but count calls, by kind. Used by the Node benchmark to report
 * how much canvas work a frame asks for (arcs, text, sprites), which is what a browser spends
 * its time on beyond the JavaScript of the draw path.
 */

import type { DrawContext } from "../src/context.js";

export const COUNTED = [
  "fill",
  "stroke",
  "arc",
  "lineTo",
  "quadraticCurveTo",
  "fillRect",
  "fillText",
  "drawImage",
  "beginPath",
] as const;

export type Counted = (typeof COUNTED)[number];

const METRICS = { width: 0 };

export class CountingContext {
  readonly counts: Record<Counted, number> = {
    fill: 0,
    stroke: 0,
    arc: 0,
    lineTo: 0,
    quadraticCurveTo: 0,
    fillRect: 0,
    fillText: 0,
    drawImage: 0,
    beginPath: 0,
  };
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  fillStyle: unknown = "#000";
  strokeStyle: unknown = "#000";
  lineWidth = 1;
  lineJoin = "miter";
  lineCap = "butt";
  lineDashOffset = 0;
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";

  reset(): void {
    for (const key of COUNTED) this.counts[key] = 0;
  }
  total(): number {
    let sum = 0;
    for (const key of COUNTED) sum += this.counts[key];
    return sum;
  }

  setTransform(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  setLineDash(): void {}
  closePath(): void {}
  moveTo(): void {}
  rect(): void {}
  clearRect(): void {}
  beginPath(): void {
    this.counts.beginPath++;
  }
  lineTo(): void {
    this.counts.lineTo++;
  }
  arc(): void {
    this.counts.arc++;
  }
  quadraticCurveTo(): void {
    this.counts.quadraticCurveTo++;
  }
  fill(): void {
    this.counts.fill++;
  }
  stroke(): void {
    this.counts.stroke++;
  }
  fillRect(): void {
    this.counts.fillRect++;
  }
  fillText(): void {
    this.counts.fillText++;
  }
  drawImage(): void {
    this.counts.drawImage++;
  }
  /** Monospace stand-in: 6.3 CSS pixels per character, close to the 10.5 px design font. */
  measureText(text: string): { width: number } {
    METRICS.width = text.length * 6.3;
    return METRICS;
  }
  createRadialGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }
  createLinearGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }

  asDrawContext(): DrawContext {
    return this as unknown as DrawContext;
  }
}
