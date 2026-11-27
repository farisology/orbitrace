/**
 * Theme and palette. Defaults come from design/tokens.json through the generated module.
 * A tool call's colour comes from its `kind`, never from its `name`.
 */

import type { ToolKind } from "@orbitrace/core";
import type { OrreryTheme } from "./api.js";
import { backingAlphas } from "./contrast.js";
import { DESIGN_COLORS } from "./generated/design.js";

/** The tool-call colour mapping from design/identity.md. */
export const DEFAULT_THEME: OrreryTheme = Object.freeze({
  background: DESIGN_COLORS.void,
  text: DESIGN_COLORS.text,
  shell: DESIGN_COLORS.pulse,
  read: DESIGN_COLORS.rig,
  edit: DESIGN_COLORS.bench,
  agent: DESIGN_COLORS.wire,
  handback: DESIGN_COLORS.bench,
  failure: DESIGN_COLORS.fault,
});

const THEME_KEYS = Object.keys(DEFAULT_THEME) as (keyof OrreryTheme)[];

/** Fill every colour the host did not override with the default. Empty strings are ignored. */
export function resolveTheme(overrides?: Partial<OrreryTheme>): OrreryTheme {
  const theme: Record<keyof OrreryTheme, string> = { ...DEFAULT_THEME };
  if (overrides) {
    for (const key of THEME_KEYS) {
      const value = overrides[key];
      if (typeof value === "string" && value.trim() !== "") theme[key] = value;
    }
  }
  return Object.freeze(theme);
}

/** Colour buckets for tool calls. Index into `Palette.buckets`. */
export const BUCKET_SHELL = 0;
export const BUCKET_READ = 1;
export const BUCKET_EDIT = 2;
export const BUCKET_AGENT = 3;
export const BUCKET_FAILURE = 4;
export const BUCKET_COUNT = 5;

/** The colour bucket of a call: failures first, then by kind. Unknown kinds draw as `read`. */
export function bucketFor(kind: ToolKind | string, failed: boolean): number {
  if (failed) return BUCKET_FAILURE;
  switch (kind) {
    case "shell":
      return BUCKET_SHELL;
    case "edit":
      return BUCKET_EDIT;
    case "agent":
      return BUCKET_AGENT;
    default:
      // read, mcp, other, and any kind a later format adds.
      return BUCKET_READ;
  }
}

/** Every colour the drawing code uses. Theme colours first, then fixed design tokens. */
export interface Palette extends OrreryTheme {
  /** Colour per bucket, indexed by the BUCKET_* constants. */
  readonly buckets: readonly string[];
  readonly main: string;
  readonly tokenArc: string;
  readonly nodeFill: string;
  readonly nodeFillDone: string;
  readonly rim: string;
  readonly rimHi: string;
  readonly dim: string;
  readonly faint: string;
  readonly white: string;
  /**
   * Opacity of the backing box (in `background`) drawn behind text in each colour, so the
   * text keeps 4.5:1 over anything drawn behind it (contrast.ts, #117). Keys are the colours
   * of `canvasTextColors`.
   */
  readonly backing: ReadonlyMap<string, number>;
}

/**
 * The least opacity of a label's backing box: the look the tags had before the contrast
 * floor (#117). Colours that need more get more.
 */
export const MIN_BACKING_ALPHA = 0.72;

/** A kind of text the renderer draws on the canvas and its colour. */
export interface CanvasText {
  readonly kind: string;
  readonly color: string;
}

/**
 * Every kind of text the renderer draws on the canvas, with the palette colour draw.ts uses for
 * it (#117). `test/contrast.test.ts` checks each against the floor, and checks that every text
 * a drawn frame contains is in one of these colours.
 */
export function canvasTextColors(
  palette: Omit<Palette, "backing" | "buckets"> & { readonly buckets: readonly string[] },
): CanvasText[] {
  return [
    { kind: "main agent label", color: palette.text },
    { kind: "agent label", color: palette.text },
    { kind: "finished agent label", color: palette.faint },
    { kind: "detail row", color: palette.dim },
    { kind: "finished agent detail row", color: palette.faint },
    { kind: "wave label", color: palette.faint },
    { kind: "wave ring summary", color: palette.dim },
    { kind: "idle-skip warp label", color: palette.text },
    { kind: "handback comet tag", color: palette.handback },
    { kind: "spoke tag, shell", color: palette.buckets[BUCKET_SHELL]! },
    { kind: "spoke tag, read", color: palette.buckets[BUCKET_READ]! },
    { kind: "spoke tag, edit", color: palette.buckets[BUCKET_EDIT]! },
    { kind: "spoke tag, agent", color: palette.buckets[BUCKET_AGENT]! },
    { kind: "spoke tag, failure", color: palette.buckets[BUCKET_FAILURE]! },
  ];
}

export function createPalette(theme: OrreryTheme): Palette {
  const colors = {
    ...theme,
    buckets: Object.freeze([theme.shell, theme.read, theme.edit, theme.agent, theme.failure]),
    main: DESIGN_COLORS.ion,
    tokenArc: DESIGN_COLORS.ledger,
    nodeFill: DESIGN_COLORS.panel,
    nodeFillDone: DESIGN_COLORS.deck,
    rim: DESIGN_COLORS.rim,
    rimHi: DESIGN_COLORS["rim-hi"],
    dim: DESIGN_COLORS.dim,
    faint: DESIGN_COLORS.faint,
    white: "#FFFFFF",
  };
  const texts = canvasTextColors(colors).map((entry) => entry.color);
  return Object.freeze({
    ...colors,
    backing: backingAlphas(theme.background, texts, MIN_BACKING_ALPHA),
  });
}

/** Backing opacity for text in `color`: from the palette, or opaque for a colour it lacks. */
export function backingAlpha(palette: Palette, color: string): number {
  return palette.backing.get(color) ?? 1;
}
