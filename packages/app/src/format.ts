/**
 * Display formatting for times, durations and token counts. Pure.
 *
 * `formatClock`, `formatDuration` and `formatTokens` are core's (#86), so the inspector, timeline
 * and feed show the same values as the renderer's canvas labels, and a clock reading and a length
 * round the same way (whole seconds, rounded down). Re-exported here so existing imports keep
 * working.
 */

export { formatClock, formatDuration, formatTokens } from "@orbitrace/core";

/** A number with thousands separators, the same in every locale: `2,517,192`. */
export function formatCount(count: number): string {
  const n = Number.isFinite(count) ? Math.round(count) : 0;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `1 call`, `2 calls`. */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * How long ago something happened, in words and the same in every locale: `just now`,
 * `12 min ago`, `3 h ago`, `2 days ago`. `at` and `now` are Unix epoch milliseconds.
 */
export function formatAgo(at: number, now: number): string {
  const seconds = Number.isFinite(at) && Number.isFinite(now) ? (now - at) / 1000 : 0;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}
