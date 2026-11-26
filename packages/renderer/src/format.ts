/**
 * Small formatting helpers for canvas labels. Called when a label changes, not every frame.
 * Compressed-to-real time is `toRealSeconds` from @orbitrace/core.
 */

/** Token count in short form: `950`, `12.3k`, `4.1M`, `1.25B`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Duration in short form: `45s`, `3m05s`, `1h07m`. Negative values count as 0. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(s / 60);
  const x = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(x).padStart(2, "0")}s`;
  return `${x}s`;
}
