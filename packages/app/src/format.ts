/** Display formatting for times, durations and token counts. Pure. */

/** A clock reading such as `0:07`, `12:34` or `1:02:03`, for seconds from the session start. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** A length in words, such as `45 s`, `8 min 53 s` or `1 h 2 min`. */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return s > 0 ? `${m} min ${s} s` : `${m} min`;
}

/** A token count, short: `812`, `4.2k`, `48.5k`, `2.52M`. */
export function formatTokens(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? count : 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 100 ? m.toFixed(2) : Math.round(m)}M`;
}

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
