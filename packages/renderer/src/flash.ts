/**
 * Flash rate (#118, WCAG 2.3.1): the spawn flash and the idle-skip warp never start more than
 * three times in any one second of real time, at any playback speed, however close together
 * agents spawn or idle gaps are skipped.
 *
 * Both effects last a fixed number of real seconds (timeline.ts), so at 64x a whole wave of
 * agents that spawned within a few replay seconds would flash within a few hundredths of a real
 * second, and idle skips a few replay seconds apart would restart the warp each time. The
 * schedule below bounds that, by calculation:
 *
 * - Every flash starts at an *onset*. Accepted onsets are at least `FLASH_MIN_GAP_SECONDS`
 *   (0.35 s) of real time apart. Four onsets in a one-second window would need three gaps
 *   inside it, 3 x 0.35 = 1.05 s > 1 s, so no window holds more than three.
 * - Spawns within `FLASH_MERGE_SECONDS` of real time of the first spawn of a burst share one
 *   flash: every agent of the burst flashes at the burst's last spawn, together, which is one
 *   onset. An agent appears at most that long before its ring flashes.
 * - Warps go first: a warp is shown when it starts at least the warp's length (1.6 s real)
 *   after the previous shown warp, so warps never overlap or restart one another; a warp that
 *   starts during another is not shown (the shown one keeps running). Bursts must then keep the
 *   gap from the shown warps on both sides, and from the previous burst; a burst that cannot is
 *   not flashed (its agents still appear, with their dispatch comet).
 *
 * Gaps are in real seconds, so in replay seconds they scale with the speed; the schedule is
 * recomputed when the speed changes (never per frame at a steady speed) and allocates nothing.
 */

/** Least real time between two flash onsets. Three per second at most (see above). */
export const FLASH_MIN_GAP_SECONDS = 0.35;
/** Spawns this close in real time to the first of a burst flash together, as one onset. */
export const FLASH_MERGE_SECONDS = 0.25;
/** The WCAG 2.3.1 general limit this schedule keeps to. */
export const MAX_FLASHES_PER_SECOND = 3;

export interface FlashSchedule {
  /** Speed this schedule was computed for; NaN before the first computation. */
  speed: number;
  /** Warp length in real seconds this schedule was computed for. */
  warpSeconds: number;
  /** Start of each agent in replay seconds (index 0 is the main agent). */
  readonly starts: Float64Array;
  /** Replay time of each warp. */
  readonly warpAt: Float64Array;
  /** Subagent indices in spawn order (start time, then index). */
  readonly spawnOrder: Uint32Array;
  /** Per agent: replay time its spawn flash starts, or NaN for no flash. */
  readonly spawnAt: Float64Array;
  /** Warp indices in time order. */
  readonly warpOrder: Uint32Array;
  /** Per warp: 1 when its effect is shown. */
  readonly warpShown: Uint8Array;
  /** Accepted onsets in replay seconds, in time order, `onsetCount` of them (for checks). */
  readonly onsets: Float64Array;
  onsetCount: number;
}

/**
 * A schedule for agents starting at `starts` (index 0 is the main agent, which never flashes)
 * and warps at `warpAt`. Allocates once, when the scene is built.
 */
export function createFlashSchedule(
  starts: ArrayLike<number>,
  warpAt: ArrayLike<number>,
): FlashSchedule {
  const n = starts.length;
  const subagents: number[] = [];
  for (let i = 1; i < n; i++) subagents.push(i);
  subagents.sort((a, b) => starts[a]! - starts[b]! || a - b);
  const warps: number[] = [];
  for (let w = 0; w < warpAt.length; w++) warps.push(w);
  warps.sort((a, b) => warpAt[a]! - warpAt[b]! || a - b);
  return {
    speed: Number.NaN,
    warpSeconds: Number.NaN,
    starts: Float64Array.from(starts),
    warpAt: Float64Array.from(warpAt),
    spawnOrder: Uint32Array.from(subagents),
    spawnAt: new Float64Array(n).fill(Number.NaN),
    warpOrder: Uint32Array.from(warps),
    warpShown: new Uint8Array(warpAt.length),
    onsets: new Float64Array(Math.max(1, n + warpAt.length)),
    onsetCount: 0,
  };
}

/** Insert `t` into the sorted onsets. Bounded by the array's length, which fits every onset. */
function addOnset(schedule: FlashSchedule, t: number): void {
  const onsets = schedule.onsets;
  let k = schedule.onsetCount++;
  while (k > 0 && onsets[k - 1]! > t) {
    onsets[k] = onsets[k - 1]!;
    k--;
  }
  onsets[k] = t;
}

/**
 * Fill `schedule` for playback at `speed` with a warp effect `warpSeconds` long (real
 * seconds). Does nothing when it already holds that speed. Allocates nothing.
 */
export function scheduleFlashes(
  schedule: FlashSchedule,
  speed: number,
  warpSeconds: number,
): FlashSchedule {
  if (schedule.speed === speed && schedule.warpSeconds === warpSeconds) return schedule;
  const starts = schedule.starts;
  const warpAt = schedule.warpAt;
  schedule.speed = speed;
  schedule.warpSeconds = warpSeconds;
  schedule.onsetCount = 0;
  const gap = FLASH_MIN_GAP_SECONDS * speed;
  const merge = FLASH_MERGE_SECONDS * speed;
  const warpLength = Math.max(gap, warpSeconds * speed);

  // 1. Warps: shown when they do not start inside the previous shown warp's effect.
  const warpOrder = schedule.warpOrder;
  let lastWarp = -Infinity;
  for (let k = 0; k < warpOrder.length; k++) {
    const w = warpOrder[k]!;
    const at = warpAt[w]!;
    if (at - lastWarp >= warpLength) {
      schedule.warpShown[w] = 1;
      lastWarp = at;
      addOnset(schedule, at);
    } else {
      schedule.warpShown[w] = 0;
    }
  }

  // 2. Spawn bursts, in spawn order, each kept clear of the shown warps and the last burst.
  const order = schedule.spawnOrder;
  const spawnAt = schedule.spawnAt;
  let lastBurst = -Infinity;
  let nextWarp = 0; // index into warpOrder of the first shown-or-not warp after the burst
  let k = 0;
  while (k < order.length) {
    const first = starts[order[k]!]!;
    let last = k;
    while (last + 1 < order.length && starts[order[last + 1]!]! <= first + merge) last++;
    const onset = starts[order[last]!]!;
    // Shown warps just before and just after the onset.
    while (nextWarp < warpOrder.length && warpAt[warpOrder[nextWarp]!]! <= onset) nextWarp++;
    let before = -Infinity;
    for (let q = nextWarp - 1; q >= 0; q--) {
      const w = warpOrder[q]!;
      if (schedule.warpShown[w] === 1) {
        before = warpAt[w]!;
        break;
      }
    }
    let after = Infinity;
    for (let q = nextWarp; q < warpOrder.length; q++) {
      const w = warpOrder[q]!;
      if (schedule.warpShown[w] === 1) {
        after = warpAt[w]!;
        break;
      }
    }
    const clear = onset - lastBurst >= gap && onset - before >= gap && after - onset >= gap;
    for (let q = k; q <= last; q++) spawnAt[order[q]!] = clear ? onset : Number.NaN;
    if (clear) {
      lastBurst = onset;
      addOnset(schedule, onset);
    }
    k = last + 1;
  }
  spawnAt[0] = Number.NaN;
  return schedule;
}

/**
 * Most onsets of `schedule` inside any window `windowSeconds` of real time long (closed at
 * both ends), at the speed it was computed for. Used by the tests and the measured note.
 */
export function maxOnsetsInWindow(schedule: FlashSchedule, windowSeconds = 1): number {
  const span = windowSeconds * schedule.speed;
  const onsets = schedule.onsets;
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < schedule.onsetCount; hi++) {
    while (onsets[hi]! - onsets[lo]! > span) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}
