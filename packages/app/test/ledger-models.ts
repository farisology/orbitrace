// In-memory replays with reply details (#190, #191) for the ledger tests: `makeModel` with cache
// writes split by lifetime, or with each reply's own model. Every value is invented.
import type {
  ReplayAgent,
  ReplayModel,
  ReplayReplyDetails,
  ReplayReplyWithDetails,
} from "@orbitrace/core";
import { makeModel } from "./helpers";

type Agents = ReplayModel["agents"];

/** `makeModel` with the details given per agent id added to that agent's first reply. */
function withFirstReplyDetails(
  details: Partial<Record<ReplayAgent["id"], ReplayReplyDetails>>,
): ReplayModel {
  const model = makeModel();
  const agents = model.agents.map((agent) => {
    const extra = details[agent.id];
    if (extra === undefined) return agent;
    const [first, ...rest] = agent.replies;
    return { ...agent, replies: [{ ...(first as ReplayReplyWithDetails), ...extra }, ...rest] };
  });
  return { ...model, agents: agents as unknown as Agents };
}

/**
 * Every reply records its cache lifetime: 40 tokens to the 5-minute cache and 110 to the 1-hour
 * cache over the session's 150. `over` adds that many 1-hour tokens to the main agent's reply
 * beyond its total, as merged lines can.
 */
export function withRecordedSplit(options: { readonly over?: number } = {}): ReplayModel {
  return withFirstReplyDetails({
    main: { cacheWrite5mTokens: 20, cacheWrite1hTokens: 30 + (options.over ?? 0) },
    a1: { cacheWrite5mTokens: 0, cacheWrite1hTokens: 50 },
    a2: { cacheWrite5mTokens: 20, cacheWrite1hTokens: 30 },
  });
}

/** Only the main agent's reply records its cache lifetime; the other 100 tokens do not. */
export function withMixedSplit(): ReplayModel {
  return withFirstReplyDetails({ main: { cacheWrite5mTokens: 20, cacheWrite1hTokens: 30 } });
}

/**
 * Replies with their own model (#190):
 * - `all`: every reply records the model it used;
 * - `some`: only the main agent's reply does;
 * - `unpriced`: as `some`, and `widget-explorer` (a1) has a second reply on an invented model
 *   the price table does not list.
 */
export function withReplyModels(kind: "all" | "some" | "unpriced"): ReplayModel {
  if (kind === "all") {
    return withFirstReplyDetails({
      main: { model: "claude-opus-5-5" },
      a1: { model: "claude-haiku-4-5" },
      a2: { model: "claude-sonnet-4-6" },
    });
  }
  const model = withFirstReplyDetails({ main: { model: "claude-opus-5-5" } });
  if (kind === "some") return model;
  const extra: ReplayReplyWithDetails = {
    t: 15,
    inputTokens: 5,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: "claude-quartz-1-0",
  };
  const agents = model.agents.map((agent) =>
    agent.id === "a1"
      ? {
          ...agent,
          replies: [...agent.replies, extra],
          totals: {
            ...agent.totals,
            replies: agent.totals.replies + 1,
            inputTokens: agent.totals.inputTokens + 5,
            outputTokens: agent.totals.outputTokens + 10,
          },
        }
      : agent,
  );
  return {
    ...model,
    agents: agents as unknown as Agents,
    totals: {
      ...model.totals,
      replies: model.totals.replies + 1,
      inputTokens: model.totals.inputTokens + 5,
      outputTokens: model.totals.outputTokens + 10,
    },
  };
}
