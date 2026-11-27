/**
 * Follow live (issue 127): the time arithmetic and the words behind follow mode. Pure.
 *
 * A running session (live status `busy` or `idle`) opens at the live edge, the end of the newest
 * snapshot, and the clock stays pinned there while new snapshots arrive (`clock.ts`). Two things
 * make that harder than "seek to the end":
 *
 * - A newer snapshot may cut a new idle gap, or grow the last one (see `ReplayWarp` and the
 *   append-stability rules in core's `model/replay.ts`). Compressed times after the cut then
 *   mean a different real moment. So the playhead is carried across a snapshot through real
 *   time: compressed time on the old timeline, to real seconds (`toRealSeconds`), back to
 *   compressed time on the new one (`toCompressedSeconds`), both from core. A paused user stays
 *   on the same real moment, and the real time at a following playhead never goes backwards.
 * - "Behind" is measured in real time, idle gaps included, because that is what the user waited
 *   through.
 */

import {
  formatDuration,
  toCompressedSeconds,
  toRealSeconds,
  type LiveStatus,
  type ReplayModel,
  type ReplayWarp,
} from "@orbitrace/core";

/**
 * Compressed seconds a following playhead is moved past a cut when its real moment was cut away
 * by the newer snapshot: 1 ms, the replay builder's resolution. Without it the playhead would sit
 * exactly on the cut, where the real time reads as the start of the removed range, earlier than
 * the moment it was showing.
 */
export const CUT_NUDGE_SECONDS = 0.001;

/** Whether a session with this live status can be followed: its process is running. */
export function isFollowable(live: LiveStatus | null | undefined): boolean {
  return live === "busy" || live === "idle";
}

/**
 * The compressed time on the `next` timeline that shows the same real moment as `time` on the
 * `previous` one. When a new cut removed that moment, the cut's position.
 */
export function remapTime(
  previous: readonly ReplayWarp[],
  time: number,
  next: readonly ReplayWarp[],
): number {
  return toCompressedSeconds(next, toRealSeconds(previous, time));
}

/**
 * Like `remapTime`, for a playhead that is following and about to move forward: when the real
 * moment was cut away, the time just after the cut, so the real time it shows is not earlier
 * than before.
 */
export function followStartTime(
  previous: readonly ReplayWarp[],
  time: number,
  next: readonly ReplayWarp[],
): number {
  const real = toRealSeconds(previous, time);
  const mapped = toCompressedSeconds(next, real);
  return toRealSeconds(next, mapped) < real ? mapped + CUT_NUDGE_SECONDS : mapped;
}

/** Real seconds between compressed time `time` and the live edge (the end of `model`). */
export function behindSeconds(model: ReplayModel, time: number): number {
  return Math.max(0, model.totals.realDuration - toRealSeconds(model.warps, time));
}

/**
 * The follow state in words, for the Live badge: `following`, `2 min 5 s behind`, or `not
 * following` when the view is at the edge (within a second) but does not follow it, for example
 * paused there.
 */
export function followStatusText(following: boolean, behind: number): string {
  if (following) return "following";
  if (!(behind >= 1)) return "not following";
  return `${formatDuration(behind)} behind`;
}
