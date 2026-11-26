/**
 * Wording for the event feed. The events come from `replayFeed` in @orbitrace/core, which
 * groups repeated failures; this file only turns ids, names and numbers into short sentences.
 */

import type { ReplayAgentId, ReplayFeedEvent } from "@orbitrace/core";
import { formatDuration, formatTokens, plural } from "./format";

export interface FeedLine {
  /** Short label shown before the text, also the colour key. */
  readonly tag: "dispatch" | "handback" | "failures" | "idle";
  readonly text: string;
  /** The agent to select when the line is chosen, if there is exactly one. */
  readonly agent: ReplayAgentId | null;
}

/** Tool names with a count when repeated, most frequent first, ties in first-seen order. */
export function summariseNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count], index) => ({ name, count, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

/** One line of the feed for one event. `names` maps agent ids to callsigns. */
export function describeFeedEvent(
  event: ReplayFeedEvent,
  names: ReadonlyMap<ReplayAgentId, string>,
): FeedLine {
  const name = (id: ReplayAgentId): string => names.get(id) ?? id;
  switch (event.kind) {
    case "dispatch":
      return {
        tag: "dispatch",
        text: `${name(event.parent)} dispatched ${plural(event.agents.length, "agent")} in wave ${
          event.wave + 1
        }: ${event.agents.map(name).join(", ")}`,
        agent: event.agents.length === 1 ? (event.agents[0] ?? null) : null,
      };
    case "handback":
      return {
        tag: "handback",
        text: `${name(event.agent)} handed back to ${name(event.parent)} (${formatTokens(
          event.outputTokens,
        )} output tokens)`,
        agent: event.agent,
      };
    case "failures":
      return {
        tag: "failures",
        text: `${plural(event.calls.length, "failed call")}: ${summariseNames(
          event.calls.map((call) => call.name),
        )} in ${event.agents.map(name).join(", ")}`,
        agent: event.agents.length === 1 ? (event.agents[0] ?? null) : null,
      };
    case "idle":
      return {
        tag: "idle",
        text: `Idle skip: ${formatDuration(event.skipped)} cut from the timeline`,
        agent: null,
      };
  }
}
