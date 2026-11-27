/**
 * Ticket #123 (finding F4 of docs/security/export-audit.md). The `roundTimes` and
 * `bucketTokens` export options: coarser times and token counts in a shared replay.
 *
 * Both keep every rule a replay v1 file follows:
 *
 * - Rounding is monotone (a time never passes a later one), so every list stays in order, every
 *   `end` stays at or after its `start`, and nothing in an agent moves before the agent's start.
 *   No time becomes negative. A cut gap's `skipped` is never rounded below one step, because the
 *   schema requires it to be more than 0. `realDuration` is `duration` plus the rounded `skipped`
 *   values, as the builder defines it.
 * - Bucketing changes reply token counts only; every agent's token totals are then the sums of
 *   its bucketed replies and the session's token totals the sums over agents, so totals still
 *   equal the sums of their parts. Counts of agents, calls, failures and replies do not change.
 */
import type {
  ReplayAgent,
  ReplayModel,
  ReplayReply,
  ReplaySessionTotals,
  ReplayTotals,
} from "../model/replay.js";

/** Whole milliseconds, the precision the replay builder writes. */
function toMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * `seconds` rounded to the nearest multiple of `step` (halves round up). `step` must be a
 * whole number of milliseconds, at least one (see `isRoundTimesStep`); the work is done in
 * whole milliseconds, so the result is written with at most three decimals and no float noise
 * (`roundToStep(0.25, 0.1)` is `0.3`, not `0.30000000000000004`).
 */
export function roundToStep(seconds: number, step: number): number {
  const stepMs = Math.max(1, toMs(step));
  return (Math.round(toMs(seconds) / stepMs) * stepMs) / 1000;
}

/**
 * The replay with every time rounded to `step` seconds: agent `start` and `end`, tool `start`
 * and `end`, reply `t`, warp `at`, `totals.duration`, warp `skipped` (at least one step) and
 * `totals.realDuration` (`duration` plus the rounded `skipped` values). `null` ends stay `null`.
 * Pure; keeps the input's key order. The input must be a valid replay v1.
 */
export function roundReplayTimes(model: ReplayModel, step: number): ReplayModel {
  const stepMs = Math.max(1, toMs(step));
  const round = (seconds: number): number => roundToStep(seconds, step);
  const roundOrNull = (seconds: number | null): number | null =>
    seconds === null ? null : round(seconds);

  const agent = <A extends ReplayAgent>(a: A): A => ({
    ...a,
    start: round(a.start),
    end: roundOrNull(a.end),
    tools: a.tools.map((tool) => ({
      ...tool,
      start: round(tool.start),
      end: roundOrNull(tool.end),
    })),
    replies: a.replies.map((reply) => ({ ...reply, t: round(reply.t) })),
  });

  const [main, ...subagents] = model.agents;
  const warps = model.warps.map((warp) => ({
    ...warp,
    at: round(warp.at),
    skipped: Math.max(stepMs, toMs(round(warp.skipped))) / 1000,
  }));
  const durationMs = toMs(round(model.totals.duration));
  const skippedMs = warps.reduce((sum, warp) => sum + toMs(warp.skipped), 0);
  const totals: ReplaySessionTotals = {
    ...model.totals,
    duration: durationMs / 1000,
    realDuration: (durationMs + skippedMs) / 1000,
  };
  return { ...model, agents: [agent(main), ...subagents.map(agent)], warps, totals };
}

/** The bucket after `value` in 1, 2, 5, 10, 20, 50, ...; `value` must be one of them. */
function nextBucket(value: number): number {
  const scale = 10 ** Math.floor(Math.log10(value) + 1e-9);
  const lead = Math.round(value / scale);
  return lead === 2 ? 5 * scale : 2 * value;
}

/**
 * A token count as a bucket: 0 (or anything not more than 0) gives 0; any other count gives the
 * nearest value of the form 1, 2 or 5 times a power of ten (1, 2, 5, 10, 20, 50, 100, ...),
 * nearest by ratio, so 3 gives 2, 4 gives 5, 140 gives 100 and 150 gives 200. The result is off
 * from the count by at most a factor of about 1.6.
 */
export function bucketTokenCount(count: number): number {
  if (!(count > 0)) return 0;
  let lower = 1;
  let upper = nextBucket(lower);
  while (upper <= count) {
    lower = upper;
    upper = nextBucket(upper);
  }
  return count / lower < upper / count ? lower : upper;
}

type TokenKey = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens";

function sumTokens(items: readonly Pick<ReplayTotals, TokenKey>[]): Pick<ReplayTotals, TokenKey> {
  const sum = (key: TokenKey): number => items.reduce((total, item) => total + item[key], 0);
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
  };
}

/**
 * The replay with every reply's four token counts bucketed (`bucketTokenCount`), every agent's
 * token totals set to the sums of its bucketed replies, and the session's token totals set to
 * the sums over agents. Pure; keeps the input's key order. The input must be a valid replay v1.
 */
export function bucketReplayTokens(model: ReplayModel): ReplayModel {
  const agent = <A extends ReplayAgent>(a: A): A => {
    const replies = a.replies.map((reply): ReplayReply => ({
      ...reply,
      inputTokens: bucketTokenCount(reply.inputTokens),
      outputTokens: bucketTokenCount(reply.outputTokens),
      cacheReadTokens: bucketTokenCount(reply.cacheReadTokens),
      cacheCreationTokens: bucketTokenCount(reply.cacheCreationTokens),
    }));
    return { ...a, replies, totals: { ...a.totals, ...sumTokens(replies) } };
  };
  const [main, ...subagents] = model.agents;
  const agents: ReplayModel["agents"] = [agent(main), ...subagents.map(agent)];
  const totals: ReplaySessionTotals = {
    ...model.totals,
    ...sumTokens(agents.map((a) => a.totals)),
  };
  return { ...model, agents, totals };
}
