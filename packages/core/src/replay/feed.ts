/**
 * Feed events derived from a replay model: dispatches, handbacks, grouped failures and idle
 * skips. The replay format has no feed field, so the feed is computed from the model on
 * either side (host or app) and is never stored or exported. Events carry ids, names and
 * numbers only; the app writes the wording.
 */

import type { ReplayAgentId, ReplayModel, ReplaySeconds, ReplaySubagent } from "../model/replay.js";

/** A parent started one or more subagents of the same wave. */
export interface ReplayDispatchEvent {
  readonly kind: "dispatch";
  /** Start of the earliest agent in the group. */
  readonly t: ReplaySeconds;
  readonly parent: ReplayAgentId;
  readonly wave: number;
  /** Ids in id order. */
  readonly agents: readonly ReplaySubagent["id"][];
}

/** A subagent finished and handed back to its parent. */
export interface ReplayHandbackEvent {
  readonly kind: "handback";
  readonly t: ReplaySeconds;
  readonly agent: ReplaySubagent["id"];
  readonly parent: ReplayAgentId;
  readonly outputTokens: number;
}

/** One failed tool call inside a failure group. */
export interface ReplayFailedCall {
  readonly agent: ReplayAgentId;
  /** Tool label as in the replay (`Bash`, `mcp:docs`). */
  readonly name: string;
  readonly t: ReplaySeconds;
}

/** Failed calls that started close together, across any agents. */
export interface ReplayFailuresEvent {
  readonly kind: "failures";
  /** Start of the first failed call in the group. */
  readonly t: ReplaySeconds;
  /** In start order. */
  readonly calls: readonly ReplayFailedCall[];
  /** Distinct agents in the group, in order of first failure. */
  readonly agents: readonly ReplayAgentId[];
}

/** An idle gap was cut at this point (one per warp). */
export interface ReplayIdleEvent {
  readonly kind: "idle";
  readonly t: ReplaySeconds;
  /** Real seconds removed. */
  readonly skipped: number;
}

export type ReplayFeedEvent =
  ReplayDispatchEvent | ReplayHandbackEvent | ReplayFailuresEvent | ReplayIdleEvent;

export interface ReplayFeedOptions {
  /**
   * A failed call joins the current group when it starts less than this many seconds after
   * the group's first failed call. Default 12, as in the prototype.
   */
  readonly failureGroupSeconds?: number;
}

export const REPLAY_FEED_DEFAULTS = {
  failureGroupSeconds: 12,
} as const satisfies ReplayFeedOptions;

const KIND_RANK: Readonly<Record<ReplayFeedEvent["kind"], number>> = {
  idle: 0,
  dispatch: 1,
  failures: 2,
  handback: 3,
};

/**
 * Feed events of a replay in time order. Events at the same time are ordered idle, dispatch,
 * failures, handback, then by the order they were produced (agent id order). Pure and
 * deterministic.
 */
export function replayFeed(
  model: ReplayModel,
  options?: ReplayFeedOptions,
): readonly ReplayFeedEvent[] {
  const window = options?.failureGroupSeconds ?? REPLAY_FEED_DEFAULTS.failureGroupSeconds;
  if (!Number.isFinite(window) || window < 0) {
    throw new RangeError("replayFeed: failureGroupSeconds must be a finite number, 0 or more");
  }
  const events: ReplayFeedEvent[] = [];
  const subagents = model.agents.slice(1) as ReplaySubagent[];

  for (const warp of model.warps) events.push({ kind: "idle", t: warp.at, skipped: warp.skipped });

  const groups = new Map<string, ReplaySubagent[]>();
  for (const agent of subagents) {
    const key = `${agent.parent}/${agent.wave}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [agent]);
    else group.push(agent);
  }
  for (const group of groups.values()) {
    const first = group[0] as ReplaySubagent;
    events.push({
      kind: "dispatch",
      t: Math.min(...group.map((agent) => agent.start)),
      parent: first.parent,
      wave: first.wave,
      agents: group.map((agent) => agent.id),
    });
  }

  const failed = model.agents
    .flatMap((agent, agentIndex) =>
      agent.tools
        .map((tool, toolIndex) => ({ tool, toolIndex }))
        .filter(({ tool }) => tool.failed)
        .map(({ tool, toolIndex }) => ({
          call: { agent: agent.id, name: tool.name, t: tool.start } satisfies ReplayFailedCall,
          agentIndex,
          toolIndex,
        })),
    )
    .sort((a, b) => a.call.t - b.call.t || a.agentIndex - b.agentIndex || a.toolIndex - b.toolIndex)
    .map((entry) => entry.call);
  for (let i = 0; i < failed.length;) {
    const head = failed[i] as ReplayFailedCall;
    const calls: ReplayFailedCall[] = [head];
    i += 1;
    while (i < failed.length && (failed[i] as ReplayFailedCall).t - head.t < window) {
      calls.push(failed[i] as ReplayFailedCall);
      i += 1;
    }
    events.push({
      kind: "failures",
      t: head.t,
      calls,
      agents: [...new Set(calls.map((call) => call.agent))],
    });
  }

  for (const agent of subagents) {
    if (agent.end !== null) {
      events.push({
        kind: "handback",
        t: agent.end,
        agent: agent.id,
        parent: agent.parent,
        outputTokens: agent.totals.outputTokens,
      });
    }
  }

  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.t - b.event.t ||
        KIND_RANK[a.event.kind] - KIND_RANK[b.event.kind] ||
        a.index - b.index,
    )
    .map(({ event }) => event);
}
