/**
 * Formatting helpers for canvas labels. Called when a label changes, not every frame.
 * Compressed-to-real time is `toRealSeconds` from @orbitrace/core.
 *
 * Both are core's display formatters (#86), so a label on the canvas and the app's panels show
 * one value one way. `formatDuration` here is core's `formatDurationShort`: the same length,
 * rounded the same way, in the compact form canvas labels have room for (`3m05s` is the app's
 * `3 min 5 s`).
 */

export { formatTokens, formatDurationShort as formatDuration } from "@orbitrace/core";
