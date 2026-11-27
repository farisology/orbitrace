/**
 * The inspector's ledger (#26): core's `sessionLedger` for the replay on screen, and the words
 * the panel shows for it. Every cost is labelled an estimate; a model the price table does not
 * cover shows its tokens and the words "not priced", never a guessed cost. See docs/ledger.md.
 */

import {
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

/**
 * What every cost in the panel is: an estimate in US dollars, the price table's date and source,
 * and what it leaves out or attributes coarsely.
 */
export function estimateNote(ledger: SessionLedger): string {
  const lifetime = ledger.cacheWrite === "1h" ? "1-hour" : "5-minute";
  return (
    `Costs are estimates in US dollars at list prices from ${ledger.pricesSource}, read on ` +
    `${readOnText(ledger.pricesReadOn)}. Cache writes are priced at the ${lifetime} cache ` +
    "price, because a transcript does not record which cache was written. A replay records " +
    "one model per agent, so an agent that switched models is counted and priced entirely at " +
    "its main model. Discounts, the Batch API, fast mode, data residency and server tool fees " +
    "are not included."
  );
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

/** The note for one agent when its model is unpriced, or `null` when it is priced. */
export function agentUnpricedNote(entry: LedgerAgentEntry): string | null {
  if (entry.pricing === "priced") return null;
  const what =
    entry.model === null
      ? "This agent's model is unknown"
      : `${entry.model} is not in the price table`;
  return `Not priced: ${what}. Its tokens are counted; its cost is not guessed.`;
}
