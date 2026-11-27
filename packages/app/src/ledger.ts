/**
 * The inspector's ledger (#26, ticket 191): core's `sessionLedger` for the replay on screen, and the
 * words the panel shows for it. Every cost is labelled an estimate; a model the price table does
 * not cover shows its tokens and the words "not priced", never a guessed cost. Cache writes are
 * shown by lifetime when the replay recorded it, and a note says when they were priced at the
 * fallback lifetime instead. See docs/ledger.md.
 */

import {
  cacheWriteBasis,
  formatCostEstimate,
  sessionLedger,
  totalTokens,
  type LedgerAgentEntry,
  type LedgerCost,
  type LedgerEntry,
  type LedgerModelEntry,
  type ReplayAgentId,
  type ReplayModel,
  type SessionLedger,
} from "@orbitrace/core";
import { formatCount } from "./format";

const cache = new WeakMap<ReplayModel, SessionLedger>();

/**
 * The ledger of a replay, computed once per snapshot. Snapshots are never changed in place (a
 * live update is a new object), so a snapshot is a safe cache key.
 */
export function ledgerOf(model: ReplayModel): SessionLedger {
  let ledger = cache.get(model);
  if (ledger === undefined) {
    ledger = sessionLedger(model);
    cache.set(model, ledger);
  }
  return ledger;
}

/** The ledger entry of one agent, or `undefined`. */
export function agentLedger(
  ledger: SessionLedger,
  id: ReplayAgentId,
): LedgerAgentEntry | undefined {
  return ledger.byAgent.find((entry) => entry.id === id);
}

/** What a cost cell shows when nothing in it could be priced. */
export const NOT_PRICED = "not priced";

/** What a partial total adds after its amount. */
export const PARTIAL = "(partial)";

/**
 * The total cost of an entry in two parts, so a cell can keep each on one line and break between
 * them: the amount (`$1.23` in US dollars, or `not priced` when nothing is priced) and the
 * qualifier (`(partial)` when some replies are unpriced, otherwise `null`).
 */
export function costParts(entry: LedgerEntry): { amount: string; qualifier: string | null } {
  if (entry.pricing === "unpriced") return { amount: NOT_PRICED, qualifier: null };
  const amount = formatCostEstimate(entry.cost.total);
  return { amount, qualifier: entry.pricing === "partial" ? PARTIAL : null };
}

/**
 * The total cost of an entry for a table cell: `$1.23`, `$1.23 (partial)` when some of its
 * replies are unpriced, or `not priced` when none is priced.
 */
export function costText(entry: LedgerEntry): string {
  const { amount, qualifier } = costParts(entry);
  return qualifier === null ? amount : `${amount} ${qualifier}`;
}

/** One token class's cost for a table cell: `$0.42`, or `not priced` when nothing is priced. */
export function classCostText(entry: LedgerEntry, key: Exclude<keyof LedgerCost, "total">): string {
  return entry.pricing === "unpriced" ? NOT_PRICED : formatCostEstimate(entry.cost[key]);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-11-27` as `27 Nov 2026`, the same in every locale. Any other text is returned as is. */
export function readOnText(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  if (match === null || month === undefined) return isoDate;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** How the model of each reply was chosen for pricing, in one sentence (ticket 190). */
export function modelSentence(entry: LedgerEntry): string {
  if (entry.ownModelReplies === 0) {
    return (
      "A replay records one model per agent, so an agent that switched models is counted and " +
      "priced entirely at its main model."
    );
  }
  if (entry.ownModelReplies === entry.replies) return "Each reply is priced at the model it used.";
  return (
    "Replies that recorded their model are priced at it; the others are priced at their " +
    "agent's main model."
  );
}

/**
 * What every cost in the panel is: an estimate in US dollars, the price table's date and source,
 * how each reply's model was chosen, and what it leaves out. How cache writes were priced is a
 * note of its own (`cacheWriteNote`).
 */
export function estimateNote(ledger: SessionLedger, entry: LedgerEntry = ledger.session): string {
  return (
    `Costs are estimates in US dollars at list prices from ${ledger.pricesSource}, read on ` +
    `${readOnText(ledger.pricesReadOn)}. ${modelSentence(entry)} Discounts, the Batch API, fast ` +
    "mode, data residency and server tool fees are not included."
  );
}

/** `5-minute` or `1-hour`: the cache lifetime as the panel writes it. */
export function lifetimeText(lifetime: SessionLedger["cacheWrite"]): string {
  return lifetime === "1h" ? "1-hour" : "5-minute";
}

/**
 * How the entry's cache writes were priced (ticket 191), or `null` when it has none. When some or all
 * of them have no recorded lifetime (an opened replay file never records it), the note says
 * they were priced at the fallback lifetime, the documented 5-minute default unless the caller
 * chose otherwise. A recorded split that goes past the total is reported, never hidden.
 */
export function cacheWriteNote(ledger: SessionLedger, entry: LedgerEntry): string | null {
  const basis = cacheWriteBasis(entry);
  const writes = entry.cacheWrites;
  const fallback = lifetimeText(ledger.cacheWrite);
  const fallbackWhy =
    ledger.cacheWrite === "5m" ? "the default lifetime in Anthropic's documentation" : "as chosen";
  let note: string;
  switch (basis) {
    case "none":
      return null;
    case "recorded":
      note =
        "Cache writes are priced at the 5-minute or the 1-hour cache price, as the transcript " +
        "recorded for each.";
      break;
    case "unrecorded":
      note =
        `Cache writes are priced at the ${fallback} cache price, ${fallbackWhy}, because this ` +
        "replay does not record which cache each write used (a replay file never does). Where " +
        `the other cache was used, the cache creation estimate is ${
          ledger.cacheWrite === "5m" ? "low" : "high"
        }.`;
      break;
    case "mixed":
      note =
        "Cache writes are priced at the 5-minute or the 1-hour cache price where the transcript " +
        `recorded which; the other ${formatCount(writes.unrecorded)} cache creation tokens have ` +
        `no recorded cache and are priced at the ${fallback} cache price, ${fallbackWhy}.`;
      break;
  }
  if (writes.overTotal > 0) {
    note +=
      ` The recorded caches add up to ${formatCount(writes.overTotal)} tokens more than the ` +
      "cache creation total; they are priced as recorded, and the token totals stay the " +
      "transcript's own.";
  }
  return note;
}

/** One row of the cache creation split: what the row header says, its tokens and its cost. */
export interface CacheWriteRow {
  readonly key: "recorded5m" | "recorded1h" | "unrecorded";
  readonly label: string;
  readonly tokens: number;
  readonly cost: string;
}

/**
 * The cache creation row split by lifetime (ticket 191), or `null` when nothing in the entry recorded
 * a lifetime (one "Cache creation" row then, with `cacheWriteNote` saying how it was priced).
 * The 5-minute and 1-hour rows are always both shown; a third row holds tokens with no recorded
 * lifetime, when there are any. Costs read "not priced" for an entry with nothing priced.
 */
export function cacheWriteRows(entry: LedgerEntry): readonly CacheWriteRow[] | null {
  const basis = cacheWriteBasis(entry);
  if (basis !== "recorded" && basis !== "mixed") return null;
  const writes = entry.cacheWrites;
  const cost = (value: bigint): string =>
    entry.pricing === "unpriced" ? NOT_PRICED : formatCostEstimate(value);
  const rows: CacheWriteRow[] = [
    {
      key: "recorded5m",
      label: "Cache creation, 5-minute cache",
      tokens: writes.recorded5m,
      cost: cost(writes.cost5m),
    },
    {
      key: "recorded1h",
      label: "Cache creation, 1-hour cache",
      tokens: writes.recorded1h,
      cost: cost(writes.cost1h),
    },
  ];
  if (writes.unrecorded > 0) {
    rows.push({
      key: "unrecorded",
      label: "Cache creation, cache not recorded",
      tokens: writes.unrecorded,
      cost: cost(writes.costUnrecorded),
    });
  }
  return rows;
}

/** A model for display: its id, or `unrecorded model (opus family)` when the replay has none. */
export function modelText(entry: Pick<LedgerModelEntry, "model" | "family">): string {
  return entry.model ?? `unrecorded model (${entry.family} family)`;
}

/**
 * The note for the session when some models are unpriced, naming each with its token count,
 * or `null` when everything is priced.
 */
export function sessionUnpricedNote(ledger: SessionLedger): string | null {
  const unpriced = ledger.byModel.filter((entry) => entry.pricing !== "priced");
  if (unpriced.length === 0) return null;
  const names = unpriced
    .map((entry) => `${modelText(entry)} (${formatCount(totalTokens(entry.tokens))} tokens)`)
    .join(", ");
  const total =
    ledger.session.pricing === "unpriced"
      ? "so there is no session estimate."
      : "so the session estimate is partial.";
  return `Not priced: ${names}. The price table does not cover ${
    unpriced.length === 1 ? "this model" : "these models"
  }. Their tokens are counted; their cost is not guessed and is left out, ${total}`;
}

/**
 * The note for one agent when some of its replies are unpriced, or `null` when all are priced.
 * Usually that is the agent's own model; with per-reply models (ticket 190) it names the models of the
 * unpriced replies.
 */
export function agentUnpricedNote(entry: LedgerAgentEntry): string | null {
  if (entry.pricing === "priced") return null;
  const models = entry.unpricedModels.length > 0 ? entry.unpricedModels : [entry.model];
  if (models.length === 1 && models[0] === entry.model) {
    const what =
      entry.model === null
        ? "This agent's model is unknown"
        : `${entry.model} is not in the price table`;
    return `Not priced: ${what}. Its tokens are counted; its cost is not guessed.`;
  }
  const named = models.map((model) => model ?? "an unknown model").join(", ");
  const total =
    entry.pricing === "partial" ? "so the estimate is partial." : "so there is no estimate.";
  return (
    `Not priced: replies of this agent used ${named}, which the price table does not ` +
    `cover. Their tokens are counted; their cost is not guessed, ${total}`
  );
}
