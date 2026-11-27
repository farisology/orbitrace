/**
 * Ticket #71: compressed replay time to real seconds, by the rule in `ReplayWarp`
 * (`model/replay.ts`). One implementation for the renderer and the app.
 *
 * Ticket #135: the inverse, real seconds to compressed time, for the app's follow mode (#127),
 * which carries the playhead through real time when a newer snapshot adds or grows a cut.
 */

import type { ToCompressedSeconds, ToRealSeconds } from "../api.js";
import type { ReplayWarp } from "../model/replay.js";

/**
 * Real seconds from the session start for compressed time `t`: `t` plus `skipped` of every warp
 * whose `at` is less than `t`. A warp at exactly `t` is not counted, so the real time jumps just
 * after a cut, not at it. Does not allocate (the renderer calls it while drawing a frame) and does
 * not rely on the warps being sorted.
 */
export const toRealSeconds: ToRealSeconds = (warps, t) => {
  let real = t;
  for (let i = 0; i < warps.length; i += 1) {
    const warp = warps[i];
    if (warp !== undefined && warp.at < t) real += warp.skipped;
  }
  return real;
};

/**
 * Significant decimal digits kept when snapping a computed compressed time (see `snap`). Far
 * finer than the replay builder's 1 ms resolution, and far coarser than the rounding error of
 * the additions in `toRealSeconds` (a few units in the last place of the real time).
 */
const SNAP_DIGITS = 13;

/**
 * `real - removed` is computed in floating point, so it can differ from the compressed time that
 * `toRealSeconds` mapped to `real` by a few units in the last place. Round it to a decimal grid
 * sized to `real`, and keep the rounded value when it maps back to exactly `real`. Every time in
 * a replay is on the builder's millisecond grid, so this gives back exactly that time.
 */
function snap(warps: readonly ReplayWarp[], real: number, compressed: number): number {
  const integerDigits = Math.max(1, Math.floor(Math.log10(real)) + 1);
  const decimals = Math.min(100, Math.max(0, SNAP_DIGITS - integerDigits));
  const rounded = Number(compressed.toFixed(decimals));
  return rounded !== compressed && toRealSeconds(warps, rounded) === real ? rounded : compressed;
}

/**
 * Compressed time for `real` seconds from the session start: the inverse of `toRealSeconds`. A
 * real time inside a removed range maps to that warp's `at` (the rule `Timeline.compress` uses).
 * `warps` must be in `at` order, as a replay holds them. A non-finite or negative `real` gives 0.
 * For every time `t` of a replay, `toCompressedSeconds(w, toRealSeconds(w, t)) === t`.
 */
export const toCompressedSeconds: ToCompressedSeconds = (warps, real) => {
  if (!Number.isFinite(real) || real <= 0) return 0;
  let removed = 0;
  for (const warp of warps) {
    const start = warp.at + removed;
    if (real <= start) break;
    if (real < start + warp.skipped) return warp.at;
    removed += warp.skipped;
  }
  if (removed === 0) return real;
  return snap(warps, real, Math.max(0, real - removed));
};
