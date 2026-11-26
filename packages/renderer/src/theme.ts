/**
 * Theme and palette. Defaults come from design/tokens.json through the generated module.
 * A tool call's colour comes from its `kind`, never from its `name`.
 */

import type { ToolKind } from "@orbitrace/core";
import type { OrreryTheme } from "./api.js";
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
}

export function createPalette(theme: OrreryTheme): Palette {
  return Object.freeze({
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
  });
}
