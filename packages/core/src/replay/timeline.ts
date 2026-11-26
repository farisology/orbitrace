/**
 * Idle-gap compression. Works in whole milliseconds from the session start (real time), so
 * every cut and every mapped time is exact; the builder divides by 1000 only when it writes
 * the replay.
 *
 * A gap between busy intervals that is longer than the idle gap is cut down to the kept
 * length. Half the kept length stays before the cut and half after it, and the removed range
 * sits in the middle. Every real time inside a removed range maps to the cut's position.
 */

import type { ReplayWarp } from "../model/replay.js";

/** A real time span in milliseconds from the session start. `end` is not before `start`. */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** Merge overlapping or touching intervals. Returns them sorted by start. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const next of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && next.start <= last.end) {
      if (next.end > last.end) merged[merged.length - 1] = { start: last.start, end: next.end };
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }
  return merged;
}

/**
 * Real ranges to remove from the timeline `[0, horizon]`. `busy` is clipped to the timeline.
 * Every idle stretch longer than `gapMs` (before the first busy interval, between two, or
 * after the last) is reduced to `keepMs`.
 */
export function findCuts(
  busy: readonly Interval[],
  horizon: number,
  gapMs: number,
  keepMs: number,
): Interval[] {
  const clipped = busy
    .map((span) => ({ start: Math.max(0, span.start), end: Math.min(horizon, span.end) }))
    .filter((span) => span.end >= span.start);
  const cuts: Interval[] = [];
  const front = Math.floor(keepMs / 2);
  const back = keepMs - front;
  const consider = (from: number, to: number): void => {
    if (to - from > gapMs && to - from > keepMs) cuts.push({ start: from + front, end: to - back });
  };
  let cursor = 0;
  for (const span of mergeIntervals(clipped)) {
    consider(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  consider(cursor, horizon);
  return cuts;
}

/**
 * Cuts for a live snapshot. Cuts from the previous snapshot are kept unchanged and in place.
 * The last of them may grow when a fresh cut starts at the same point and reaches further
 * (an idle stretch that was still going on). Fresh cuts after the last kept one are appended;
 * fresh cuts overlapping a kept one are dropped.
 */
export function mergeLiveCuts(
  previous: readonly Interval[],
  fresh: readonly Interval[],
): Interval[] {
  const result = previous.map((cut) => ({ start: cut.start, end: cut.end }));
  const last = result[result.length - 1];
  if (last === undefined) return fresh.map((cut) => ({ start: cut.start, end: cut.end }));
  let boundary = last.end;
  for (const cut of fresh) {
    if (cut.start === last.start && cut.end > last.end && result.length === previous.length) {
      result[result.length - 1] = { start: last.start, end: cut.end };
      boundary = cut.end;
    } else if (cut.start > boundary) {
      result.push({ start: cut.start, end: cut.end });
      boundary = cut.end;
    }
  }
  return result;
}

/** Rebuild real removed ranges, in milliseconds, from the warps of a replay. */
export function cutsFromWarps(warps: readonly ReplayWarp[]): Interval[] {
  const cuts: Interval[] = [];
  let removed = 0;
  for (const warp of warps) {
    const at = Math.round(warp.at * 1000);
    const skipped = Math.round(warp.skipped * 1000);
    cuts.push({ start: at + removed, end: at + removed + skipped });
    removed += skipped;
  }
  return cuts;
}

/** Maps real milliseconds to compressed milliseconds for a fixed list of cuts. */
export class Timeline {
  readonly #cuts: readonly Interval[];

  /** `cuts` must be sorted and must not overlap. */
  constructor(cuts: readonly Interval[]) {
    this.#cuts = cuts;
  }

  /** Real time to compressed time. A time inside a removed range maps to that cut's position. */
  compress(real: number): number {
    let removed = 0;
    for (const cut of this.#cuts) {
      if (real <= cut.start) break;
      if (real < cut.end) return cut.start - removed;
      removed += cut.end - cut.start;
    }
    return real - removed;
  }

  /** Warps in compressed milliseconds: position of each cut and the real time it removed. */
  warpsMs(): { at: number; skipped: number }[] {
    let removed = 0;
    return this.#cuts.map((cut) => {
      const warp = { at: cut.start - removed, skipped: cut.end - cut.start };
      removed += warp.skipped;
      return warp;
    });
  }
}
