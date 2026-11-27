/**
 * Text for a session in the Sessions view, the quick pick and the editor tab title. Built from
 * a path-free `SessionSummary` only. The session id is never shown: it is local data a
 * screenshot should not carry. No vscode dependency, so it is unit tested.
 */

import { formatAgo, type SessionSummary } from "@orbitrace/core";

export interface SessionText {
  /** The project name. */
  readonly label: string;
  /** Last activity, live status and subagent count, for example `5 min ago · live · 3 subagents`. */
  readonly description: string;
  /** One line per fact, for a hover. */
  readonly tooltip: string;
}

/**
 * `just now`, `5 min ago`, `3 h ago`, `2 days ago`. A time in the future reads `just now`.
 * Core's `formatAgo` (#129), so this view and the app's session picker word last activity the
 * same way. Kept under this name so existing imports keep working.
 */
export const relativeTime: (then: number, now: number) => string = formatAgo;

/** `live` for a session whose process is running, `ended`, or null when unknown. */
export function liveText(live: SessionSummary["live"]): string | null {
  if (live === "busy" || live === "idle") return "live";
  if (live === "ended") return "ended";
  return null;
}

/** The project label, or a placeholder when it is empty. */
export function projectText(summary: Pick<SessionSummary, "projectLabel">): string {
  const label = summary.projectLabel.trim();
  return label === "" ? "(unnamed project)" : label;
}

/** Shown for a session kept only in the history store (#211). */
export const HISTORY_TEXT = "history";

/** The hover line of a session kept only in the history store (#211). */
export const HISTORY_TOOLTIP =
  "Kept in the Orbitrace history store: its transcript is no longer in the Claude Code folders.";

/** How a session was found. */
export interface DescribeOptions {
  /** Found only in the history store: marked `history` instead of its live status. */
  readonly fromHistory?: boolean;
}

/** Text for one session at time `now` (Unix epoch milliseconds). */
export function describeSession(
  summary: SessionSummary,
  now: number,
  options: DescribeOptions = {},
): SessionText {
  const parts = [relativeTime(summary.lastActivity, now)];
  const live = options.fromHistory === true ? HISTORY_TEXT : liveText(summary.live);
  if (live !== null) parts.push(live);
  if (summary.subagentCount !== null && summary.subagentCount > 0) {
    parts.push(summary.subagentCount === 1 ? "1 subagent" : `${summary.subagentCount} subagents`);
  }
  const label = projectText(summary);
  const tooltip = [
    label,
    `Last activity: ${new Date(summary.lastActivity).toISOString().replace("T", " ").slice(0, 16)} UTC`,
    `Status: ${summary.live}`,
    `Subagents: ${summary.subagentCount === null ? "not counted" : String(summary.subagentCount)}`,
    ...(options.fromHistory === true ? [HISTORY_TOOLTIP] : []),
  ].join("\n");
  return { label, description: parts.join(" · "), tooltip };
}

/** Title of the editor tab for a session. */
export function panelTitle(summary: Pick<SessionSummary, "projectLabel"> | null): string {
  return summary === null ? "Orbitrace: demo" : `Orbitrace: ${projectText(summary)}`;
}
