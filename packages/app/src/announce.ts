/**
 * Words for the polite live region: what a screen reader user hears when a replay loads, when a
 * live session changes state, when a live snapshot adds agents and when the view starts or stops
 * following the live edge. Pure.
 *
 * Nothing here runs per frame. Playback position is not announced: the scrubber carries it.
 */

import type { LiveStatus, ReplayModel } from "@orbitrace/core";
import { plural } from "./format";

/** Shortest gap between two announcements of new agents in a live session, in milliseconds. */
export const LIVE_ANNOUNCE_INTERVAL_MS = 10_000;

/** `Showing Demo session: 15 agents, 208 tool calls.` */
export function loadedAnnouncement(label: string, model: ReplayModel): string {
  return `Showing ${label}: ${plural(model.agents.length, "agent")}, ${plural(
    model.totals.toolCalls,
    "tool call",
  )}.`;
}

/** What changed when a followed session's status went from `before` to `after`, or `null`. */
export function liveStatusAnnouncement(before: LiveStatus, after: LiveStatus): string | null {
  if (before === after) return null;
  switch (after) {
    case "busy":
      return "Live session is working.";
    case "idle":
      return "Live session is idle.";
    case "ended":
      return before === "busy" || before === "idle" ? "Live session ended." : null;
    default:
      return null;
  }
}

/** What is said when the view starts or stops following the live edge (issue 127). */
export const FOLLOW_ANNOUNCEMENTS = {
  entered: "Following the live session.",
  left: "Stopped following the live session. Go live, or press End, to return.",
} as const;

/**
 * What to say when follow mode changed from `before` to `after`, or `null`. Leaving follow
 * because the session ended (`live` is false) says nothing here: "Live session ended." covers it.
 * Called on transitions only, so it is said once per change and never per snapshot.
 */
export function followAnnouncement(before: boolean, after: boolean, live: boolean): string | null {
  if (before === after) return null;
  if (after) return FOLLOW_ANNOUNCEMENTS.entered;
  return live ? FOLLOW_ANNOUNCEMENTS.left : null;
}

/**
 * `2 new agents in the live session, 9 in total.` when a snapshot has more agents than were last
 * announced, or `null`.
 */
export function newAgentsAnnouncement(announcedCount: number, model: ReplayModel): string | null {
  const added = model.agents.length - announcedCount;
  if (added <= 0) return null;
  return `${plural(added, "new agent")} in the live session, ${model.agents.length} in total.`;
}
