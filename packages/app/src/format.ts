/**
 * Display formatting for times, durations and token counts. Pure.
 *
 * `formatClock`, `formatDuration` and `formatTokens` are core's (#86), so the inspector, timeline
 * and feed show the same values as the renderer's canvas labels, and a clock reading and a length
 * round the same way (whole seconds, rounded down). `formatAgo` is core's too (issue 129), so the
 * session picker and the editor's Sessions view word last activity the same way. Re-exported here
 * so existing imports keep working.
 */

export { formatAgo, formatClock, formatDuration, formatTokens } from "@orbitrace/core";

/** A number with thousands separators, the same in every locale: `2,517,192`. */
export function formatCount(count: number): string {
  const n = Number.isFinite(count) ? Math.round(count) : 0;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `1 call`, `2 calls`. */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
