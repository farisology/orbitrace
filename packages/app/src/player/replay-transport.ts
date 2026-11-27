/**
 * The host transport for one replay the player opened (a file or a linked replay): the
 * no-host transport over a single bundled session whose data is already in memory. The app
 * shows it as an ended session with `label` in the header, and reads it once.
 */

import type { ReplayModel, SessionSummary } from "@orbitrace/core";
import { createNoHostTransport } from "../no-host-transport";
import type { HostTransport } from "../transport";

/** Key of the opened replay in its transport. Not a session id: there is no session behind it. */
export const PLAYER_REPLAY_KEY = "player-replay";

/** The summary the app lists for an opened replay. */
export function replaySummary(model: ReplayModel, label: string): SessionSummary {
  return {
    key: PLAYER_REPLAY_KEY,
    runtime: "claude-code",
    projectLabel: label,
    sessionId: PLAYER_REPLAY_KEY,
    lastActivity: 0,
    live: "ended",
    subagentCount: Math.max(0, model.agents.length - 1),
  };
}

/** A transport that serves `model` under `label`. */
export function createReplayTransport(model: ReplayModel, label: string): HostTransport {
  return createNoHostTransport([{ summary: replaySummary(model, label), load: async () => model }]);
}
