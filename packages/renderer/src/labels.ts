/**
 * Canvas text with a cached width. `measureText` allocates a metrics object, so each label is
 * measured once and reused. Labels that show a changing number are interned per value, so a
 * frame that shows a value seen before allocates nothing.
 */

import type { DrawContext } from "./context.js";
import { DESIGN_FONTS } from "./generated/design.js";

/** A canvas font: the CSS `font` value and its size in CSS pixels. */
export interface CanvasFont {
  readonly css: string;
  readonly size: number;
}

export class Label {
  /** Width in CSS pixels in `font`, or -1 before the first measurement. */
  width = -1;
  constructor(
    readonly text: string,
    readonly font: CanvasFont,
  ) {}
}

function font(weight: number, size: number, stack: string): CanvasFont {
  return Object.freeze({ css: `${weight} ${size}px ${stack}`, size });
}

/** Canvas fonts. Built once from the design font stacks. */
export const FONTS = Object.freeze({
  main: font(600, 12, DESIGN_FONTS.mono),
  agent: font(400, 10.5, DESIGN_FONTS.mono),
  agentBold: font(600, 10.5, DESIGN_FONTS.mono),
  small: font(400, 9, DESIGN_FONTS.mono),
  warp: font(600, 20, DESIGN_FONTS.display),
  warpNarrow: font(600, 15, DESIGN_FONTS.display),
});

/** Width of a label, measuring it on first use. Leaves `ctx.font` set to the label's font. */
export function measureLabel(ctx: DrawContext, label: Label): number {
  ctx.font = label.font.css;
  if (label.width < 0) label.width = ctx.measureText(label.text).width;
  return label.width;
}

/** Interned labels for non-negative integers, formatted once per value. */
export class IntLabelCache {
  private readonly items: (Label | undefined)[] = [];

  constructor(
    private readonly font: CanvasFont,
    private readonly format: (n: number) => string,
    /** Values above this share the label of `limit`, which bounds memory. */
    private readonly limit = 1_000_000,
    /**
     * How a fractional value becomes the integer that is formatted. Durations pass `Math.floor`
     * so the canvas rounds down like core's formatters and the app (#86).
     */
    private readonly round: (value: number) => number = Math.round,
  ) {}

  get(value: number): Label {
    const n = Math.min(this.limit, Math.max(0, this.round(value)));
    let label = this.items[n];
    if (label === undefined) {
      label = new Label(this.format(n), this.font);
      this.items[n] = label;
    }
    return label;
  }

  /** Number of labels created so far. */
  get size(): number {
    let count = 0;
    for (const item of this.items) if (item !== undefined) count++;
    return count;
  }
}
