/**
 * Ticket #26. The ledger of one session: token totals in the four classes and a cost estimate,
 * for the session, per model and per agent, from a replay and a price table. Pure and
 * browser-safe (no Node API), so the host and the app compute the same numbers.
 *
 * What is counted: every reply of every agent in the replay, with its four token classes
 * (input, output, cache read, cache creation) as the transcript recorded them.
 *
 * Model of a reply: a replay records one model per agent (the model most of its replies used,
 * see `ReplayAgentBase.model`), not one per reply. So "per model" groups agents by that model,
 * and every reply of an agent is priced at its agent's model. An agent that switched models
 * part way is priced entirely at its main model.
 *
 * Unpriced: an agent whose model is `null`, or whose id the table does not list, is unpriced.
 * Its tokens are counted in every token total; its cost is never guessed and is left out of
 * every cost total, and each total it belongs to is marked `partial` (or `unpriced`). A model
 * that is `null` with a known family (what `names: "opaque"` export writes for an id it does
 * not keep) is unpriced too: one family covers model generations with different prices, so the
 * family alone does not say which price applies.
 *
 * Arithmetic: a price is a whole number of micro-dollars per million tokens, so tokens times
 * price is an exact whole number of picodollars (10^-12 dollars). Costs are kept as `bigint`
 * picodollars, summed exactly, and rounded once, for display (`formatCostEstimate`).
 *
 * Not broken down by tool: a replay does not link a reply to the tool calls around it, and a
 * reply's input tokens hold the whole conversation so far, so there is no honest rule that
 * gives a tool call its share of the tokens. Not broken down by project: that needs the
 * history store across sessions.
 */

import type {
  ModelFamily,
  ReplayAgent,
  ReplayAgentId,
  ReplayModel,
  ReplayReply,
} from "../model/replay.js";
import {
  DEFAULT_CACHE_WRITE_LIFETIME,
  DEFAULT_PRICE_TABLE,
  checkPriceTable,
  findModelPrice,
  type CacheWriteLifetime,
  type ModelPrice,
  type PriceTable,
  type TokenPrices,
} from "./prices.js";

/** Token counts in the four classes. */
export interface LedgerTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/** Cost estimate in the four classes and in total, in picodollars (10^-12 US dollars). */
export interface LedgerCost {
  readonly input: bigint;
  readonly output: bigint;
  readonly cacheRead: bigint;
  readonly cacheCreation: bigint;
  readonly total: bigint;
}

/**
 * How much of an entry's cost is known.
 * - `priced`: every reply is priced (or there is none).
 * - `partial`: some replies are priced, some are not; the cost covers the priced ones only.
 * - `unpriced`: there are replies and none is priced; the cost is 0 and means nothing.
 */
export type LedgerPricing = "priced" | "partial" | "unpriced";

/** Tokens and cost of a group of replies. */
export interface LedgerEntry {
  readonly replies: number;
  /** Every reply's tokens, priced or not. */
  readonly tokens: LedgerTokens;
  /** The estimate over priced replies only. */
  readonly cost: LedgerCost;
  readonly unpricedReplies: number;
  /** The tokens of unpriced replies (included in `tokens`, left out of `cost`). */
  readonly unpricedTokens: LedgerTokens;
  readonly pricing: LedgerPricing;
}

/** One model of the session: every agent whose model it is. */
export interface LedgerModelEntry extends LedgerEntry {
  /** Model id as the replay writes it, or `null` when the replay has none. */
  readonly model: string | null;
  /** The agents' family. With `model: null`, agents are grouped by family. */
  readonly family: ModelFamily;
  /** The price table's label, such as `Claude Opus 5.5`, or `null` when unpriced. */
  readonly label: string | null;
  /** The agents counted here, in replay order. */
  readonly agents: readonly ReplayAgentId[];
}

/** One agent of the session. */
export interface LedgerAgentEntry extends LedgerEntry {
  readonly id: ReplayAgentId;
  readonly callsign: string;
  readonly model: string | null;
  readonly family: ModelFamily;
  /** The price table's label, or `null` when unpriced. */
  readonly label: string | null;
}

export interface SessionLedger {
  readonly session: LedgerEntry;
  /** Models in order of first appearance, walking agents in replay order. */
  readonly byModel: readonly LedgerModelEntry[];
  /** Agents in replay order (main first). */
  readonly byAgent: readonly LedgerAgentEntry[];
  /** The cache lifetime cache creation tokens were priced at. */
  readonly cacheWrite: CacheWriteLifetime;
  /** Date and source of the price table used. */
  readonly pricesReadOn: string;
  readonly pricesSource: string;
}

export interface SessionLedgerOptions {
  /** The price table. Default `DEFAULT_PRICE_TABLE`. A table passed here is checked first. */
  readonly prices?: PriceTable;
  /** The cache lifetime to price cache creation tokens at. Default `5m`. */
  readonly cacheWrite?: CacheWriteLifetime;
}

const ZERO_TOKENS: LedgerTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

const ZERO_COST: LedgerCost = {
  input: 0n,
  output: 0n,
  cacheRead: 0n,
  cacheCreation: 0n,
  total: 0n,
};

/** A count as the builder keeps it: a whole number of at least 0. */
const count = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** A reply's four token classes. */
export function replyTokens(reply: ReplayReply): LedgerTokens {
  return {
    input: count(reply.inputTokens),
    output: count(reply.outputTokens),
    cacheRead: count(reply.cacheReadTokens),
    cacheCreation: count(reply.cacheCreationTokens),
  };
}

/**
 * The prices that apply to one reply: the long-prompt prices when the model has them and the
 * reply's prompt (input plus cache read plus cache creation tokens) is over their threshold.
 */
export function pricesForReply(entry: ModelPrice, tokens: LedgerTokens): TokenPrices {
  const long = entry.longPrompt;
  if (long === undefined) return entry.prices;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return prompt > long.overPromptTokens ? long.prices : entry.prices;
}

/** The exact cost of one reply at one model's prices, in picodollars. */
export function replyCost(
  reply: ReplayReply,
  entry: ModelPrice,
  cacheWrite: CacheWriteLifetime = DEFAULT_CACHE_WRITE_LIFETIME,
): LedgerCost {
  const tokens = replyTokens(reply);
  const prices = pricesForReply(entry, tokens);
  const write = cacheWrite === "1h" ? prices.cacheWrite1h : prices.cacheWrite5m;
  const input = BigInt(tokens.input) * BigInt(prices.input);
  const output = BigInt(tokens.output) * BigInt(prices.output);
  const cacheRead = BigInt(tokens.cacheRead) * BigInt(prices.cacheRead);
  const cacheCreation = BigInt(tokens.cacheCreation) * BigInt(write);
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    total: input + output + cacheRead + cacheCreation,
  };
}

/** Sum of token counts. */
export function addTokens(a: LedgerTokens, b: LedgerTokens): LedgerTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

/** Sum of costs. */
export function addCost(a: LedgerCost, b: LedgerCost): LedgerCost {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    total: a.total + b.total,
  };
}

/** The sum of all four token classes. */
export function totalTokens(tokens: LedgerTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

function pricingOf(replies: number, unpricedReplies: number): LedgerPricing {
  if (unpricedReplies === 0) return "priced";
  return unpricedReplies === replies ? "unpriced" : "partial";
}

/** The sum of several entries, with `pricing` worked out again from the reply counts. */
export function sumEntries(entries: readonly LedgerEntry[]): LedgerEntry {
  let replies = 0;
  let unpricedReplies = 0;
  let tokens = ZERO_TOKENS;
  let unpricedTokens = ZERO_TOKENS;
  let cost = ZERO_COST;
  for (const entry of entries) {
    replies += entry.replies;
    unpricedReplies += entry.unpricedReplies;
    tokens = addTokens(tokens, entry.tokens);
    unpricedTokens = addTokens(unpricedTokens, entry.unpricedTokens);
    cost = addCost(cost, entry.cost);
  }
  return {
    replies,
    tokens,
    cost,
    unpricedReplies,
    unpricedTokens,
    pricing: pricingOf(replies, unpricedReplies),
  };
}

/** Tokens and cost of one agent's replies at its model's price (or unpriced). */
export function agentEntry(
  agent: ReplayAgent,
  table: PriceTable = DEFAULT_PRICE_TABLE,
  cacheWrite: CacheWriteLifetime = DEFAULT_CACHE_WRITE_LIFETIME,
): LedgerAgentEntry {
  const price = findModelPrice(table, agent.model);
  let tokens = ZERO_TOKENS;
  let cost = ZERO_COST;
  for (const reply of agent.replies) {
    tokens = addTokens(tokens, replyTokens(reply));
    if (price !== undefined) cost = addCost(cost, replyCost(reply, price, cacheWrite));
  }
  const replies = agent.replies.length;
  const unpricedReplies = price === undefined ? replies : 0;
  return {
    id: agent.id,
    callsign: agent.callsign,
    model: agent.model,
    family: agent.family,
    label: price?.label ?? null,
    replies,
    tokens,
    cost,
    unpricedReplies,
    unpricedTokens: price === undefined ? tokens : ZERO_TOKENS,
    pricing: pricingOf(replies, unpricedReplies),
  };
}

/**
 * The ledger of one replay: the session total, one entry per model and one per agent. Throws a
 * `TypeError` (fixed text) when `options.prices` is not a valid table or `options.cacheWrite`
 * is not `5m` or `1h`.
 */
export function sessionLedger(
  model: ReplayModel,
  options: SessionLedgerOptions = {},
): SessionLedger {
  const table =
    options.prices === undefined ? DEFAULT_PRICE_TABLE : checkPriceTable(options.prices);
  const cacheWrite = options.cacheWrite ?? DEFAULT_CACHE_WRITE_LIFETIME;
  if (cacheWrite !== "5m" && cacheWrite !== "1h") {
    throw new TypeError('SessionLedgerOptions.cacheWrite must be "5m" or "1h"');
  }
  const byAgent = model.agents.map((agent) => agentEntry(agent, table, cacheWrite));

  const groups = new Map<string, LedgerAgentEntry[]>();
  for (const entry of byAgent) {
    // A model id never contains a space, so this key cannot collide with a real id.
    const key = entry.model ?? `family ${entry.family}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  const byModel = [...groups.values()].map((group): LedgerModelEntry => {
    const first = group[0] as LedgerAgentEntry;
    return {
      model: first.model,
      family: first.family,
      label: first.label,
      agents: group.map((entry) => entry.id),
      ...sumEntries(group),
    };
  });

  return {
    session: sumEntries(byAgent),
    byModel,
    byAgent,
    cacheWrite,
    pricesReadOn: table.readOn,
    pricesSource: table.sourceName,
  };
}
