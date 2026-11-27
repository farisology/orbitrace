/**
 * Tickets #26 and #191. The ledger of one session: token totals in the four classes and a cost
 * estimate, for the session, per model and per agent, from a replay and a price table. Pure and
 * browser-safe (no Node API), so the host and the app compute the same numbers.
 *
 * What is counted: every reply of every agent in the replay, with its four token classes
 * (input, output, cache read, cache creation) as the transcript recorded them.
 *
 * Model of a reply (#190, #191): a reply's own model when the in-memory model carries it
 * (`ReplayReplyDetails.model`), otherwise its agent's model (the model most of the agent's
 * replies used, see `ReplayAgentBase.model`). A replay file never carries a reply's own model, so
 * there every reply of an agent is priced at its agent's model, and an agent that switched models
 * part way is priced entirely at its main model. "Per model" groups replies by the model they
 * were priced at, so one agent can appear under more than one model.
 *
 * Cache writes (#191): when a reply carries its cache writes by lifetime
 * (`ReplayReplyDetails.cacheWrite5mTokens` and `cacheWrite1hTokens`), each part is priced at its
 * own price. Cache creation tokens with no recorded lifetime (a replay file, a transcript from a
 * Claude Code version that does not write the split, or the part of a reply's total its split
 * does not cover) are priced at `SessionLedgerOptions.cacheWrite`, by default the 5-minute price,
 * the lifetime Anthropic's prompt caching documentation names as the default. Nothing is dropped:
 * when a split records more tokens than the reply's total (possible after merging the lines of a
 * reply by maximum), the split is priced as recorded and the excess is reported
 * (`LedgerCacheWrites.overTotal`); the token totals stay the replay's own.
 *
 * Unpriced: a reply whose model is `null`, or whose id the table does not list, is unpriced.
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
  ReplayReplyWithDetails,
} from "../model/replay.js";
import { familyOf } from "../replay/names.js";
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
 * #191. The cache creation tokens of a group of replies by cache lifetime, and their estimated
 * cost. Tokens count every reply, priced or not; costs cover priced replies only and add up to
 * `LedgerCost.cacheCreation`. Always `recorded5m + recorded1h + unrecorded - overTotal` equals
 * `LedgerTokens.cacheCreation`.
 */
export interface LedgerCacheWrites {
  /** Tokens the transcript recorded as written to the 5-minute cache. */
  readonly recorded5m: number;
  /** Tokens the transcript recorded as written to the 1-hour cache. */
  readonly recorded1h: number;
  /**
   * Cache creation tokens with no recorded lifetime: all of a reply that has no split, and the
   * part of a reply's total that its split does not cover. Priced at `SessionLedger.cacheWrite`.
   */
  readonly unrecorded: number;
  /**
   * Tokens by which recorded splits go past their replies' totals (0 when every split adds up).
   * They are priced, as part of the split, but are not in `LedgerTokens.cacheCreation`.
   */
  readonly overTotal: number;
  /** Estimated cost of `recorded5m`, in picodollars. */
  readonly cost5m: bigint;
  /** Estimated cost of `recorded1h`, in picodollars. */
  readonly cost1h: bigint;
  /** Estimated cost of `unrecorded`, at the fallback lifetime, in picodollars. */
  readonly costUnrecorded: bigint;
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
  /** #191. Cache creation tokens and cost by cache lifetime. */
  readonly cacheWrites: LedgerCacheWrites;
  /** #190. Replies priced at their own recorded model rather than their agent's model. */
  readonly ownModelReplies: number;
}

/** One model of the session: every reply priced at it. */
export interface LedgerModelEntry extends LedgerEntry {
  /** Model id, or `null` when neither the reply nor its agent has one. */
  readonly model: string | null;
  /** The model's family. With `model: null`, replies are grouped by their agent's family. */
  readonly family: ModelFamily;
  /** The price table's label, such as `Claude Opus 5.5`, or `null` when unpriced. */
  readonly label: string | null;
  /** The agents with replies counted here (or with no replies and this model), in replay order. */
  readonly agents: readonly ReplayAgentId[];
}

/** One agent of the session. */
export interface LedgerAgentEntry extends LedgerEntry {
  readonly id: ReplayAgentId;
  readonly callsign: string;
  /** The agent's model as the replay writes it. */
  readonly model: string | null;
  readonly family: ModelFamily;
  /** The price table's label for the agent's model, or `null` when it is unpriced. */
  readonly label: string | null;
  /**
   * The models of this agent's unpriced replies, each once, in order of first reply (`null` for
   * a reply with no model). Empty when everything is priced.
   */
  readonly unpricedModels: readonly (string | null)[];
}

export interface SessionLedger {
  readonly session: LedgerEntry;
  /** Models in order of first appearance, walking agents in replay order, then their replies. */
  readonly byModel: readonly LedgerModelEntry[];
  /** Agents in replay order (main first). */
  readonly byAgent: readonly LedgerAgentEntry[];
  /** The cache lifetime that cache creation tokens with no recorded lifetime were priced at. */
  readonly cacheWrite: CacheWriteLifetime;
  /** Date and source of the price table used. */
  readonly pricesReadOn: string;
  readonly pricesSource: string;
}

export interface SessionLedgerOptions {
  /** The price table. Default `DEFAULT_PRICE_TABLE`. A table passed here is checked first. */
  readonly prices?: PriceTable;
  /**
   * The cache lifetime to price cache creation tokens at when the reply does not record its
   * lifetime. Default `5m`. A recorded split is always priced as recorded.
   */
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

const ZERO_CACHE_WRITES: LedgerCacheWrites = {
  recorded5m: 0,
  recorded1h: 0,
  unrecorded: 0,
  overTotal: 0,
  cost5m: 0n,
  cost1h: 0n,
  costUnrecorded: 0n,
};

/** A count as the builder keeps it: a whole number of at least 0. */
const count = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** A reply's four token classes. */
export function replyTokens(reply: ReplayReplyWithDetails): LedgerTokens {
  return {
    input: count(reply.inputTokens),
    output: count(reply.outputTokens),
    cacheRead: count(reply.cacheReadTokens),
    cacheCreation: count(reply.cacheCreationTokens),
  };
}

/** #191. A reply's cache creation tokens by lifetime (see `LedgerCacheWrites`), tokens only. */
export interface ReplyCacheWriteTokens {
  readonly recorded5m: number;
  readonly recorded1h: number;
  readonly unrecorded: number;
  readonly overTotal: number;
  /** True when the reply carries a split (either count), so at least part was recorded. */
  readonly split: boolean;
}

/**
 * #191. How a reply's cache creation tokens divide by lifetime. Without a split, all of them are
 * unrecorded. With one, a missing count of the two is 0, the part of the total the split does
 * not cover is unrecorded, and a split above the total is reported as `overTotal`.
 */
export function replyCacheWriteTokens(reply: ReplayReplyWithDetails): ReplyCacheWriteTokens {
  const total = count(reply.cacheCreationTokens);
  const has5m = reply.cacheWrite5mTokens !== undefined;
  const has1h = reply.cacheWrite1hTokens !== undefined;
  if (!has5m && !has1h) {
    return { recorded5m: 0, recorded1h: 0, unrecorded: total, overTotal: 0, split: false };
  }
  const recorded5m = has5m ? count(reply.cacheWrite5mTokens as number) : 0;
  const recorded1h = has1h ? count(reply.cacheWrite1hTokens as number) : 0;
  const recorded = recorded5m + recorded1h;
  return {
    recorded5m,
    recorded1h,
    unrecorded: Math.max(0, total - recorded),
    overTotal: Math.max(0, recorded - total),
    split: true,
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

/** One reply at one model's prices: its cost and its cache writes by lifetime. */
function priceReply(
  reply: ReplayReplyWithDetails,
  entry: ModelPrice,
  cacheWrite: CacheWriteLifetime,
): { cost: LedgerCost; cacheWrites: LedgerCacheWrites } {
  const tokens = replyTokens(reply);
  const writes = replyCacheWriteTokens(reply);
  const prices = pricesForReply(entry, tokens);
  const fallback = cacheWrite === "1h" ? prices.cacheWrite1h : prices.cacheWrite5m;
  const input = BigInt(tokens.input) * BigInt(prices.input);
  const output = BigInt(tokens.output) * BigInt(prices.output);
  const cacheRead = BigInt(tokens.cacheRead) * BigInt(prices.cacheRead);
  const cost5m = BigInt(writes.recorded5m) * BigInt(prices.cacheWrite5m);
  const cost1h = BigInt(writes.recorded1h) * BigInt(prices.cacheWrite1h);
  const costUnrecorded = BigInt(writes.unrecorded) * BigInt(fallback);
  const cacheCreation = cost5m + cost1h + costUnrecorded;
  return {
    cost: {
      input,
      output,
      cacheRead,
      cacheCreation,
      total: input + output + cacheRead + cacheCreation,
    },
    cacheWrites: {
      recorded5m: writes.recorded5m,
      recorded1h: writes.recorded1h,
      unrecorded: writes.unrecorded,
      overTotal: writes.overTotal,
      cost5m,
      cost1h,
      costUnrecorded,
    },
  };
}

/**
 * The exact cost of one reply at one model's prices, in picodollars. A recorded cache-write
 * split is priced by lifetime; `cacheWrite` prices the cache creation tokens with no recorded
 * lifetime.
 */
export function replyCost(
  reply: ReplayReplyWithDetails,
  entry: ModelPrice,
  cacheWrite: CacheWriteLifetime = DEFAULT_CACHE_WRITE_LIFETIME,
): LedgerCost {
  return priceReply(reply, entry, cacheWrite).cost;
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

/** #191. Sum of cache writes by lifetime. */
export function addCacheWrites(a: LedgerCacheWrites, b: LedgerCacheWrites): LedgerCacheWrites {
  return {
    recorded5m: a.recorded5m + b.recorded5m,
    recorded1h: a.recorded1h + b.recorded1h,
    unrecorded: a.unrecorded + b.unrecorded,
    overTotal: a.overTotal + b.overTotal,
    cost5m: a.cost5m + b.cost5m,
    cost1h: a.cost1h + b.cost1h,
    costUnrecorded: a.costUnrecorded + b.costUnrecorded,
  };
}

/** The sum of all four token classes. */
export function totalTokens(tokens: LedgerTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

/**
 * #191. Where an entry's cache-write prices come from:
 * - `none`: it has no cache creation tokens;
 * - `recorded`: every cache creation token has a recorded lifetime and is priced at it;
 * - `unrecorded`: no token has a recorded lifetime, so all are priced at the fallback lifetime
 *   (`SessionLedger.cacheWrite`): a replay file, or a transcript without the split;
 * - `mixed`: some are recorded and some are priced at the fallback lifetime.
 */
export type CacheWriteBasis = "none" | "recorded" | "unrecorded" | "mixed";

/** #191. The `CacheWriteBasis` of an entry. */
export function cacheWriteBasis(entry: Pick<LedgerEntry, "cacheWrites">): CacheWriteBasis {
  const { recorded5m, recorded1h, unrecorded } = entry.cacheWrites;
  const recorded = recorded5m + recorded1h > 0;
  if (unrecorded === 0) return recorded ? "recorded" : "none";
  return recorded ? "mixed" : "unrecorded";
}

function pricingOf(replies: number, unpricedReplies: number): LedgerPricing {
  if (unpricedReplies === 0) return "priced";
  return unpricedReplies === replies ? "unpriced" : "partial";
}

/** The sum of several entries, with `pricing` worked out again from the reply counts. */
export function sumEntries(entries: readonly LedgerEntry[]): LedgerEntry {
  let replies = 0;
  let unpricedReplies = 0;
  let ownModelReplies = 0;
  let tokens = ZERO_TOKENS;
  let unpricedTokens = ZERO_TOKENS;
  let cost = ZERO_COST;
  let cacheWrites = ZERO_CACHE_WRITES;
  for (const entry of entries) {
    replies += entry.replies;
    unpricedReplies += entry.unpricedReplies;
    ownModelReplies += entry.ownModelReplies;
    tokens = addTokens(tokens, entry.tokens);
    unpricedTokens = addTokens(unpricedTokens, entry.unpricedTokens);
    cost = addCost(cost, entry.cost);
    cacheWrites = addCacheWrites(cacheWrites, entry.cacheWrites);
  }
  return {
    replies,
    tokens,
    cost,
    unpricedReplies,
    unpricedTokens,
    pricing: pricingOf(replies, unpricedReplies),
    cacheWrites,
    ownModelReplies,
  };
}

/** The model a reply is priced at, and the family to group it under. */
interface ReplyModel {
  readonly model: string | null;
  readonly family: ModelFamily;
  readonly own: boolean;
}

function modelOfReply(agent: ReplayAgent, reply: ReplayReplyWithDetails): ReplyModel {
  const own = reply.model;
  if (typeof own === "string" && own !== "") {
    return { model: own, family: own === agent.model ? agent.family : familyOf(own), own: true };
  }
  return { model: agent.model, family: agent.family, own: false };
}

/** The ledger entry of one reply at one model's price (or unpriced). */
function replyEntry(
  reply: ReplayReplyWithDetails,
  price: ModelPrice | undefined,
  cacheWrite: CacheWriteLifetime,
  own: boolean,
): LedgerEntry {
  const tokens = replyTokens(reply);
  const ownModelReplies = own ? 1 : 0;
  if (price === undefined) {
    const writes = replyCacheWriteTokens(reply);
    return {
      replies: 1,
      tokens,
      cost: ZERO_COST,
      unpricedReplies: 1,
      unpricedTokens: tokens,
      pricing: "unpriced",
      cacheWrites: {
        ...ZERO_CACHE_WRITES,
        recorded5m: writes.recorded5m,
        recorded1h: writes.recorded1h,
        unrecorded: writes.unrecorded,
        overTotal: writes.overTotal,
      },
      ownModelReplies,
    };
  }
  const { cost, cacheWrites } = priceReply(reply, price, cacheWrite);
  return {
    replies: 1,
    tokens,
    cost,
    unpricedReplies: 0,
    unpricedTokens: ZERO_TOKENS,
    pricing: "priced",
    cacheWrites,
    ownModelReplies,
  };
}

/** One reply's entry with the model it was priced at, as `agentParts` returns it. */
interface PricedReply {
  readonly entry: LedgerEntry;
  readonly model: ReplyModel;
  readonly label: string | null;
}

function agentParts(
  agent: ReplayAgent,
  table: PriceTable,
  cacheWrite: CacheWriteLifetime,
): PricedReply[] {
  return agent.replies.map((reply) => {
    const model = modelOfReply(agent, reply);
    const price = findModelPrice(table, model.model);
    return {
      entry: replyEntry(reply, price, cacheWrite, model.own),
      model,
      label: price?.label ?? null,
    };
  });
}

function agentEntryOf(
  agent: ReplayAgent,
  table: PriceTable,
  parts: readonly PricedReply[],
): LedgerAgentEntry {
  const unpricedModels: (string | null)[] = [];
  for (const part of parts) {
    if (part.entry.pricing === "priced") continue;
    if (!unpricedModels.includes(part.model.model)) unpricedModels.push(part.model.model);
  }
  return {
    id: agent.id,
    callsign: agent.callsign,
    model: agent.model,
    family: agent.family,
    label: findModelPrice(table, agent.model)?.label ?? null,
    unpricedModels,
    ...sumEntries(parts.map((part) => part.entry)),
  };
}

/**
 * Tokens and cost of one agent's replies: each at its own recorded model, else at the agent's
 * model (or unpriced). Cache creation tokens without a recorded lifetime are priced at
 * `cacheWrite`.
 */
export function agentEntry(
  agent: ReplayAgent,
  table: PriceTable = DEFAULT_PRICE_TABLE,
  cacheWrite: CacheWriteLifetime = DEFAULT_CACHE_WRITE_LIFETIME,
): LedgerAgentEntry {
  return agentEntryOf(agent, table, agentParts(agent, table, cacheWrite));
}

/** A model group being filled while `sessionLedger` walks the replies. */
interface ModelGroup {
  readonly model: string | null;
  readonly family: ModelFamily;
  readonly label: string | null;
  readonly agents: ReplayAgentId[];
  readonly entries: LedgerEntry[];
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

  const groups = new Map<string, ModelGroup>();
  const groupFor = (replyModel: ReplyModel, label: string | null): ModelGroup => {
    // A model id never contains a space, so this key cannot collide with a real id.
    const key = replyModel.model ?? `family ${replyModel.family}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        model: replyModel.model,
        family: replyModel.family,
        label,
        agents: [],
        entries: [],
      };
      groups.set(key, group);
    }
    return group;
  };

  const byAgent = model.agents.map((agent) => {
    const parts = agentParts(agent, table, cacheWrite);
    if (parts.length === 0) {
      // An agent with no replies is still listed under its own model, as before #191.
      const own: ReplyModel = { model: agent.model, family: agent.family, own: false };
      groupFor(own, findModelPrice(table, agent.model)?.label ?? null).agents.push(agent.id);
    }
    for (const part of parts) {
      const group = groupFor(part.model, part.label);
      if (!group.agents.includes(agent.id)) group.agents.push(agent.id);
      group.entries.push(part.entry);
    }
    return agentEntryOf(agent, table, parts);
  });

  const byModel = [...groups.values()].map((group): LedgerModelEntry => ({
    model: group.model,
    family: group.family,
    label: group.label,
    agents: group.agents,
    ...sumEntries(group.entries),
  }));

  return {
    session: sumEntries(byAgent),
    byModel,
    byAgent,
    cacheWrite,
    pricesReadOn: table.readOn,
    pricesSource: table.sourceName,
  };
}
