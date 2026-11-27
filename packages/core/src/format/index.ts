/**
 * Display formatters for token counts, lengths, clock readings and how long ago something
 * happened (#86, #129). Pure and browser-safe, so the renderer's canvas labels, the app's panels
 * and the hosts' session lists show one value one way.
 *
 * Rules:
 * - Token counts: whole numbers below 1,000; then `k`, `M` and `B`, with one decimal for `k` and
 *   two for `M` and `B` below 100 of the unit, and whole units from 100 up (`4.2k`, `149k`,
 *   `2.52M`, `250M`, `1.25B`). A value that rounds up to 1,000 of a unit moves to the next unit.
 * - Times: whole seconds, rounded down, for clock readings and lengths alike. A length of
 *   1067.7 s reads `17 min 47 s` and the clock at that moment reads `17:47`. Negative and
 *   non-finite values count as 0.
 * - `formatDurationShort` is the same length as `formatDuration`, in a compact form for canvas
 *   labels where space is short (`3m05s` is `3 min 5 s`).
 * - `formatAgo` is the last-activity text of a session list, the same in the app's session
 *   picker and the editor's Sessions view (#129): whole units, rounded down, the same in every
 *   locale. A time in the future, or a non-finite input, reads `just now`.
 */

const TOKEN_UNITS = [
  { size: 1e3, suffix: "k", decimals: 1 },
  { size: 1e6, suffix: "M", decimals: 2 },
  { size: 1e9, suffix: "B", decimals: 2 },
] as const;

/** A token count, short: `812`, `4.2k`, `48.5k`, `149k`, `2.52M`, `250M`, `1.25B`. */
export function formatTokens(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? count : 0;
  const whole = Math.round(n);
  if (whole < 1000) return String(whole);
  for (let i = 0; i < TOKEN_UNITS.length; i++) {
    const unit = TOKEN_UNITS[i]!;
    const value = n / unit.size;
    const fixed = value.toFixed(unit.decimals);
    if (Number(fixed) < 100) return `${fixed}${unit.suffix}`;
    const rounded = Math.round(value);
    if (rounded < 1000 || i === TOKEN_UNITS.length - 1) return `${rounded}${unit.suffix}`;
  }
  // Not reached: the last unit always returns.
  return String(whole);
}

/** Whole seconds, rounded down; negative and non-finite values count as 0. */
function wholeSeconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

/** A clock reading such as `0:07`, `12:34` or `1:02:03`, for seconds from the session start. */
export function formatClock(seconds: number): string {
  const total = wholeSeconds(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** A length in words, such as `45 s`, `8 min 53 s` or `1 h 2 min`. Seconds are left out from 1 h. */
export function formatDuration(seconds: number): string {
  const total = wholeSeconds(seconds);
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return s > 0 ? `${m} min ${s} s` : `${m} min`;
}

/** The same length as `formatDuration`, compact for canvas labels: `45s`, `3m05s`, `1h07m`. */
export function formatDurationShort(seconds: number): string {
  const total = wholeSeconds(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago something happened, in words and the same in every locale: `just now`,
 * `12 min ago`, `3 h ago`, `1 day ago`, `2 days ago`. `at` and `now` are Unix epoch milliseconds.
 * Units are whole and rounded down. Less than a minute ago, a time in the future, and a
 * non-finite `at` or `now` read `just now`.
 */
export function formatAgo(at: number, now: number): string {
  const elapsed = now - at;
  if (!Number.isFinite(elapsed) || elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
