/**
 * The inspector's ledger (#26): tokens in four classes with a cost estimate per class, for the
 * session or one agent, and for the session a breakdown by model and by agent. Every cost is
 * labelled an estimate, and an unpriced model says so. Numbers come from core's ledger
 * (`ledgerOf`), so they reconcile with the replay's totals.
 */

import {
  totalTokens,
  type LedgerAgentEntry,
  type LedgerCost,
  type LedgerEntry,
  type LedgerTokens,
  type SessionLedger,
} from "@orbitrace/core";
import { formatCount } from "../format";
import {
  agentUnpricedNote,
  classCostText,
  costParts,
  estimateNote,
  modelText,
  sessionUnpricedNote,
} from "../ledger";
import "../ledger.css";

type TokenClass = Exclude<keyof LedgerCost, "total"> & keyof LedgerTokens;

const CLASSES: readonly [TokenClass, string][] = [
  ["input", "Input"],
  ["output", "Output"],
  ["cacheRead", "Cache read"],
  ["cacheCreation", "Cache creation"],
];

/** Class of a cost cell: the cost colour, dimmed when the entry is not priced at all. */
function costClass(entry: LedgerEntry): string {
  return entry.pricing === "unpriced" ? "ledger-cost ledger-unpriced-cost" : "ledger-cost";
}

/** Header of every cost column. Prices are in US dollars; the header says so. */
export const COST_HEADER = "Estimated cost (USD)";

/**
 * A total cost cell: the amount and the `(partial)` qualifier as two spans, each kept on one
 * line, with a normal space between them so a narrow panel breaks there (ledger.css).
 */
function TotalCost({ entry }: { entry: LedgerEntry }) {
  const { amount, qualifier } = costParts(entry);
  return (
    <td className={costClass(entry)}>
      <span className="ledger-amount">{amount}</span>
      {qualifier === null ? null : (
        <>
          {" "}
          <span className="ledger-qualifier">{qualifier}</span>
        </>
      )}
    </td>
  );
}

/** Four token classes and their estimated cost, with a total row. */
export function LedgerTokenTable({ entry, caption }: { entry: LedgerEntry; caption: string }) {
  return (
    <table className="stat-table ledger-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Class</th>
          <th scope="col">Tokens</th>
          <th scope="col">{COST_HEADER}</th>
        </tr>
      </thead>
      <tbody>
        {CLASSES.map(([key, label]) => (
          <tr key={key}>
            <th scope="row">{label}</th>
            <td>{formatCount(entry.tokens[key])}</td>
            <td className={costClass(entry)}>{classCostText(entry, key)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td>{formatCount(totalTokens(entry.tokens))}</td>
          <TotalCost entry={entry} />
        </tr>
      </tfoot>
    </table>
  );
}

/** One row per model: all four classes added up, and the estimate. */
export function LedgerModelTable({ ledger }: { ledger: SessionLedger }) {
  return (
    <table className="stat-table ledger-table">
      <caption>{`${COST_HEADER} by model`}</caption>
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">Tokens</th>
          <th scope="col">{COST_HEADER}</th>
        </tr>
      </thead>
      <tbody>
        {ledger.byModel.map((entry) => (
          <tr key={entry.model ?? `family ${entry.family}`}>
            <th scope="row" className="ledger-name">
              {modelText(entry)}
            </th>
            <td>{formatCount(totalTokens(entry.tokens))}</td>
            <TotalCost entry={entry} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One row per agent, in replay order: all four classes added up, and the estimate. */
export function LedgerAgentTable({ ledger }: { ledger: SessionLedger }) {
  return (
    <table className="stat-table ledger-table">
      <caption>{`${COST_HEADER} by agent`}</caption>
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">Tokens</th>
          <th scope="col">{COST_HEADER}</th>
        </tr>
      </thead>
      <tbody>
        {ledger.byAgent.map((entry) => (
          <tr key={entry.id}>
            <th scope="row" className="ledger-name">
              {entry.callsign}
            </th>
            <td>{formatCount(totalTokens(entry.tokens))}</td>
            <TotalCost entry={entry} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Notes({ ledger, unpriced }: { ledger: SessionLedger; unpriced: string | null }) {
  return (
    <>
      {unpriced === null ? null : <p className="ledger-note ledger-unpriced">{unpriced}</p>}
      <p className="ledger-note">{estimateNote(ledger)}</p>
    </>
  );
}

/** The session's ledger: tokens and estimate, then by model and by agent, then the notes. */
export function SessionLedgerView({ ledger }: { ledger: SessionLedger }) {
  return (
    <div className="ledger">
      <LedgerTokenTable entry={ledger.session} caption="Session tokens" />
      <LedgerModelTable ledger={ledger} />
      <LedgerAgentTable ledger={ledger} />
      <Notes ledger={ledger} unpriced={sessionUnpricedNote(ledger)} />
    </div>
  );
}

/** One agent's ledger: tokens and estimate, then the notes. */
export function AgentLedgerView({
  ledger,
  entry,
}: {
  ledger: SessionLedger;
  entry: LedgerAgentEntry;
}) {
  return (
    <div className="ledger">
      <LedgerTokenTable entry={entry} caption="Tokens" />
      <Notes ledger={ledger} unpriced={agentUnpricedNote(entry)} />
    </div>
  );
}
