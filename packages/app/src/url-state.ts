/**
 * Start-up options read from the page URL, so a view can be linked or captured:
 *
 * - `t=<seconds>`: start at this compressed time.
 * - `select=<agent id>`: select this agent (`main`, `a1`, ...).
 * - `speed=<rate>`: one of `PLAYBACK_RATES`.
 * - `paused`: do not start playing.
 *
 * Unknown or malformed values are ignored. The values are applied to the first replay shown.
 */

import type { ReplayAgentId, ReplayModel } from "@orbitrace/core";
import { isAgentId } from "./agent-stats";
import { PLAYBACK_RATES } from "./clock";

export interface StartOptions {
  readonly time: number | null;
  readonly select: ReplayAgentId | null;
  readonly rate: number | null;
  readonly paused: boolean;
}

export const NO_START_OPTIONS: StartOptions = {
  time: null,
  select: null,
  rate: null,
  paused: false,
};

/** Read start options from a query string such as `?t=200&select=a5&paused`. */
export function parseStartOptions(search: string): StartOptions {
  const params = new URLSearchParams(search);
  const rawTime = params.get("t");
  const time = rawTime === null || rawTime.trim() === "" ? NaN : Number(rawTime);
  const rawSelect = params.get("select");
  const rate = Number(params.get("speed"));
  const paused = params.has("paused") && params.get("paused") !== "false";
  return {
    time: Number.isFinite(time) && time >= 0 ? time : null,
    select: rawSelect !== null && isAgentId(rawSelect) ? rawSelect : null,
    rate: (PLAYBACK_RATES as readonly number[]).includes(rate) ? rate : null,
    paused,
  };
}

/** The selection to apply for a model: the asked-for agent only when the model has it. */
export function startSelection(options: StartOptions, model: ReplayModel): ReplayAgentId | null {
  const wanted = options.select;
  if (wanted === null) return null;
  return model.agents.some((agent) => agent.id === wanted) ? wanted : null;
}
