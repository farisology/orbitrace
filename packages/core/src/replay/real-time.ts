/**
 * Ticket #71: compressed replay time to real seconds, by the rule in `ReplayWarp`
 * (`model/replay.ts`). One implementation for the renderer and the app.
 */

import type { ToRealSeconds } from "../api.js";

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
