/**
 * Tickets #122 and #123. Checking the opt-in `ExportOptions` (`names`, `roundTimes`,
 * `bucketTokens`) and turning them into one resolved value.
 *
 * Every check throws a `TypeError` with fixed text: an option's value is never quoted, so the
 * message can be shown or logged whatever the caller passed.
 */
import type { ExportNames, ExportOptions } from "../api.js";

/** The values of `ExportOptions.names`. `as-written` is the default. */
export const EXPORT_NAMES: readonly ExportNames[] = ["as-written", "opaque"];

/** Smallest `ExportOptions.roundTimes` step, in seconds: one millisecond, the builder's precision. */
export const ROUND_TIMES_MIN_STEP = 0.001;

/** Largest `ExportOptions.roundTimes` step, in seconds: one hour. */
export const ROUND_TIMES_MAX_STEP = 3600;

/** The opt-in options of one export, resolved: each one has its value or its default. */
export interface ResolvedExportOptions {
  readonly names: ExportNames;
  /** The rounding step in seconds, or `null` when times are not rounded. */
  readonly roundTimes: number | null;
  readonly bucketTokens: boolean;
}

/** The resolved value of an export with no option given: the output is the plain export. */
export const DEFAULT_EXPORT_OPTIONS: ResolvedExportOptions = {
  names: "as-written",
  roundTimes: null,
  bucketTokens: false,
};

/** Whether a value is one of `EXPORT_NAMES`. */
export function isExportNames(value: unknown): value is ExportNames {
  return (EXPORT_NAMES as readonly unknown[]).includes(value);
}

/**
 * Whether a value is an allowed `ExportOptions.roundTimes` step: a finite number from
 * `ROUND_TIMES_MIN_STEP` to `ROUND_TIMES_MAX_STEP` that is a whole number of milliseconds
 * (`0.1`, `0.25`, `1`, `5`; not `0.0005` or `1/3`). Keeping steps to whole milliseconds means a
 * rounded time is written with at most three decimals.
 */
export function isRoundTimesStep(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value < ROUND_TIMES_MIN_STEP || value > ROUND_TIMES_MAX_STEP) return false;
  const ms = value * 1000;
  return Math.abs(ms - Math.round(ms)) < 1e-6;
}

/**
 * Check the opt-in options and give each its value or default. Throws a `TypeError` naming the
 * option (never its value) when one has a wrong type or value. `format` and `pretty` are checked
 * by `exportReplay` itself.
 */
export function resolveExportOptions(options: ExportOptions = {}): ResolvedExportOptions {
  const loose = options as Readonly<Record<string, unknown>>;
  const orDefault = (value: unknown, fallback: unknown): unknown =>
    value === undefined ? fallback : value;
  const names = orDefault(loose["names"], DEFAULT_EXPORT_OPTIONS.names);
  const roundTimes = loose["roundTimes"];
  const bucketTokens = orDefault(loose["bucketTokens"], DEFAULT_EXPORT_OPTIONS.bucketTokens);
  if (!isExportNames(names)) {
    throw new TypeError(
      `ExportOptions.names must be one of: ${EXPORT_NAMES.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  if (roundTimes !== undefined && !isRoundTimesStep(roundTimes)) {
    throw new TypeError(
      `ExportOptions.roundTimes must be a number of seconds from ${ROUND_TIMES_MIN_STEP} to ${ROUND_TIMES_MAX_STEP}, a whole number of milliseconds`,
    );
  }
  if (typeof bucketTokens !== "boolean") {
    throw new TypeError("ExportOptions.bucketTokens must be a boolean");
  }
  return {
    names,
    // Snap to whole milliseconds, so 0.1 + float noise is treated as exactly 0.1.
    roundTimes: roundTimes === undefined ? null : Math.round(roundTimes * 1000) / 1000,
    bucketTokens,
  };
}

/** Whether resolved options change anything: false means the plain export, byte for byte. */
export function changesOutput(options: ResolvedExportOptions): boolean {
  return options.names !== "as-written" || options.roundTimes !== null || options.bucketTokens;
}
