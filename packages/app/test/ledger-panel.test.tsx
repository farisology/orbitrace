// The inspector's ledger panel (#26, #191): tables, labels, the unpriced note, the cache-write
// split and its fallback note, and axe-core with the app's style sheets and ledger.css. Every
// value is invented.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReplayModel, ReplaySubagent } from "@orbitrace/core";
import { createClock } from "../src/clock";
import { Inspector } from "../src/components/Inspector";
import {
  AgentLedgerView,
  COST_HEADER,
  LedgerAgentTable,
  LedgerModelTable,
  LedgerTokenTable,
  SessionLedgerView,
} from "../src/components/LedgerTables";
import { agentLedger, ledgerOf, NOT_PRICED } from "../src/ledger";
import { ClockContext } from "../src/use-clock";
import { axeProblems, useAppStyles } from "./axe";
import { declaration, rule } from "./css";
import { DEMO, makeModel } from "./helpers";
import { withMixedSplit, withRecordedSplit, withReplyModels } from "./ledger-models";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ledgerCss = readFileSync(join(srcDir, "ledger.css"), "utf8");

beforeAll(() => {
  useAppStyles();
  const style = document.createElement("style");
  style.textContent = ledgerCss;
  document.head.append(style);
});

function withUnpriced(): ReplayModel {
  const model = makeModel();
  const [main, a1, a2] = model.agents as unknown as [
    ReplayModel["agents"][0],
    ReplaySubagent,
    ReplaySubagent,
  ];
  return { ...model, agents: [main, a1, { ...a2, model: null, family: "sonnet" }] };
}

function withClock(children: ReactNode) {
  return (
    <ClockContext.Provider value={createClock({ time: 0, duration: 60 })}>
      <main>{children}</main>
    </ClockContext.Provider>
  );
}

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

describe("LedgerTokenTable", () => {
  it("shows four classes with tokens and an estimated cost, and a total", () => {
    const ledger = ledgerOf(makeModel());
    render(withClock(<LedgerTokenTable entry={ledger.session} caption="Session tokens" />));
    const table = screen.getByRole("table", { name: "Session tokens" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Class", "Tokens", COST_HEADER]);
    expect(COST_HEADER).toBe("Estimated cost (USD)");
    // makeModel: three replies of 10 input, 300 + 1,200 + 40 output, 100 cache read, 50 creation.
    expect(cells(within(table).getByRole("row", { name: /^Input/ }))[0]).toBe("30");
    expect(cells(within(table).getByRole("row", { name: /^Output/ }))[0]).toBe("1,540");
    expect(cells(within(table).getByRole("row", { name: /^Cache read/ }))[0]).toBe("300");
    expect(cells(within(table).getByRole("row", { name: /^Cache creation/ }))[0]).toBe("150");
    const total = within(table).getByRole("row", { name: /^Total/ });
    expect(cells(total)[0]).toBe("2,020");
    expect(cells(total)[1]).toMatch(/^\$\d+\.\d\d$|^< \$0\.01$/);
  });

  it("writes not priced, never a cost, for an unpriced entry", () => {
    const entry = agentLedger(ledgerOf(withUnpriced()), "a2")!;
    render(withClock(<LedgerTokenTable entry={entry} caption="Tokens" />));
    const table = screen.getByRole("table", { name: "Tokens" });
    for (const row of within(table).getAllByRole("row").slice(1)) {
      expect(cells(row)[1]).toBe(NOT_PRICED);
    }
    expect(cells(within(table).getByRole("row", { name: /^Output/ }))[0]).toBe("40");
  });
});

describe("LedgerTokenTable with cache writes by lifetime (#191)", () => {
  const rowHeaders = (table: HTMLElement) =>
    within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);

  it("shows the cache creation row split in two, each with tokens and an estimated cost", () => {
    const ledger = ledgerOf(withRecordedSplit());
    render(withClock(<LedgerTokenTable entry={ledger.session} caption="Session tokens" />));
    const table = screen.getByRole("table", { name: "Session tokens" });
    expect(rowHeaders(table)).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Cache creation, 5-minute cache",
      "Cache creation, 1-hour cache",
      "Total",
    ]);
    // Column headers name the units for every row.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Class", "Tokens", COST_HEADER]);
    const fiveMinutes = within(table).getByRole("row", { name: /5-minute cache/ });
    expect(cells(fiveMinutes)[0]).toBe("40");
    expect(cells(fiveMinutes)[1]).toMatch(/^(\$\d+\.\d\d|< \$0\.01)$/);
    expect(cells(within(table).getByRole("row", { name: /1-hour cache/ }))[0]).toBe("110");
    // The total is still the replay's own.
    expect(cells(within(table).getByRole("row", { name: /^Total/ }))[0]).toBe("2,020");
  });

  it("adds a row for cache writes with no recorded lifetime", () => {
    const ledger = ledgerOf(withMixedSplit());
    render(withClock(<LedgerTokenTable entry={ledger.session} caption="Session tokens" />));
    const table = screen.getByRole("table", { name: "Session tokens" });
    expect(rowHeaders(table)).toContain("Cache creation, cache not recorded");
    expect(cells(within(table).getByRole("row", { name: /cache not recorded/ }))[0]).toBe("100");
  });

  it("keeps one cache creation row, and says why, when no lifetime is recorded", () => {
    render(withClock(<SessionLedgerView ledger={ledgerOf(makeModel())} />));
    const table = screen.getByRole("table", { name: "Session tokens" });
    expect(rowHeaders(table)).toContain("Cache creation");
    const note = screen.getByText(/^Cache writes are priced at the 5-minute cache price/);
    expect(note.textContent).toContain("does not record which cache each write used");
    expect(note.className).toContain("ledger-note");
  });

  it("says each lifetime is priced as recorded, and every cost stays an estimate", () => {
    render(withClock(<SessionLedgerView ledger={ledgerOf(withRecordedSplit())} />));
    expect(screen.getByText(/as the transcript recorded for each\.$/)).toBeDefined();
    expect(screen.getByText(/^Costs are estimates in US dollars/)).toBeDefined();
    for (const table of screen.getAllByRole("table")) {
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
      expect(headers).toContain(COST_HEADER);
    }
  });

  it("splits an agent's own cache creation row in its view", () => {
    const ledger = ledgerOf(withMixedSplit());
    render(withClock(<AgentLedgerView ledger={ledger} entry={agentLedger(ledger, "main")!} />));
    const table = screen.getByRole("table", { name: "Tokens" });
    expect(cells(within(table).getByRole("row", { name: /5-minute cache/ }))[0]).toBe("20");
    expect(within(table).queryByRole("row", { name: /cache not recorded/ })).toBeNull();
    // a1 recorded nothing: one row and the fallback note.
    const a1 = agentLedger(ledger, "a1")!;
    render(withClock(<AgentLedgerView ledger={ledger} entry={a1} />));
    expect(screen.getByText(/^Cache writes are priced at the 5-minute cache price/)).toBeDefined();
  });

  it("says each reply is priced at its own model when the replay records it", () => {
    render(withClock(<SessionLedgerView ledger={ledgerOf(withReplyModels("all"))} />));
    expect(screen.getByText(/Each reply is priced at the model it used\./)).toBeDefined();
  });
});

describe("LedgerModelTable and LedgerAgentTable", () => {
  it("list every model and every agent, with partial and unpriced marked", () => {
    const ledger = ledgerOf(withUnpriced());
    render(
      withClock(
        <>
          <LedgerModelTable ledger={ledger} />
          <LedgerAgentTable ledger={ledger} />
        </>,
      ),
    );
    const models = screen.getByRole("table", { name: "Estimated cost (USD) by model" });
    expect(
      within(models)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["claude-opus-5-5", "claude-haiku-4-5", "unrecorded model (sonnet family)"]);
    expect(cells(within(models).getByRole("row", { name: /^unrecorded/ }))).toEqual([
      "200",
      NOT_PRICED,
    ]);
    const agents = screen.getByRole("table", { name: "Estimated cost (USD) by agent" });
    expect(
      within(agents)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["main", "widget-explorer", "gadget-builder"]);
    expect(cells(within(agents).getByRole("row", { name: /^gadget-builder/ }))[1]).toBe(NOT_PRICED);
  });
});

describe("SessionLedgerView and AgentLedgerView", () => {
  it("label the estimate and add the unpriced note only when it applies", () => {
    const priced = ledgerOf(makeModel());
    const { unmount } = render(withClock(<SessionLedgerView ledger={priced} />));
    // The currency is named: `$` alone could be any dollar.
    const note = screen.getByText(/^Costs are estimates in US dollars at list prices/);
    // A replay has one model per agent; the panel says how a model switch is counted.
    expect(note.textContent).toContain(
      "A replay records one model per agent, so an agent that switched models is counted and " +
        "priced entirely at its main model.",
    );
    expect(screen.queryByText(/^Not priced:/)).toBeNull();
    unmount();

    const partial = ledgerOf(withUnpriced());
    render(withClock(<SessionLedgerView ledger={partial} />));
    const total = within(screen.getByRole("table", { name: "Session tokens" })).getByRole("row", {
      name: /^Total/,
    });
    expect(cells(total)[1]).toMatch(/\(partial\)$/);
    // Amount and qualifier are separate spans, so the cell can break between them.
    const cost = within(total).getAllByRole("cell")[1]!;
    expect(cost.querySelector(".ledger-amount")?.textContent).toMatch(/^(\$\d+\.\d\d|< \$0\.01)$/);
    expect(cost.querySelector(".ledger-qualifier")?.textContent).toBe("(partial)");
    expect(screen.getByText(/^Not priced: unrecorded model \(sonnet family\)/)).toBeDefined();
  });

  it("explain an unpriced agent", () => {
    const ledger = ledgerOf(withUnpriced());
    render(withClock(<AgentLedgerView ledger={ledger} entry={agentLedger(ledger, "a2")!} />));
    expect(screen.getByText(/^Not priced: This agent's model is unknown/)).toBeDefined();
  });
});

describe("Inspector with the ledger", () => {
  it("keeps the session facts and adds the estimate by model and by agent", () => {
    const model = withUnpriced();
    render(withClock(<Inspector model={model} selected={null} onSelect={() => {}} />));
    const inspector = screen.getByRole("region", { name: "Session" });
    expect(within(inspector).getByText(/Select an agent/)).toBeDefined();
    expect(within(inspector).getByRole("table", { name: "Session tokens" })).toBeDefined();
    expect(
      within(inspector).getByRole("table", { name: "Estimated cost (USD) by model" }),
    ).toBeDefined();
    expect(
      within(inspector).getByRole("table", { name: "Estimated cost (USD) by agent" }),
    ).toBeDefined();
  });

  it("keeps the agent facts and tool table and shows the agent's tokens with its estimate", () => {
    render(withClock(<Inspector model={makeModel()} selected="a1" onSelect={() => {}} />));
    const inspector = screen.getByRole("region", { name: "Agent" });
    const tokens = within(inspector).getByRole("table", { name: "Tokens" });
    expect(cells(within(tokens).getByRole("row", { name: /^Output/ }))[0]).toBe("1,200");
    expect(within(inspector).getByRole("table", { name: "Tool calls by kind" })).toBeDefined();
    expect(within(inspector).queryByText(/^Not priced:/)).toBeNull();
  });
});

// happy-dom lays nothing out, so these guard the rules measured in Chrome (docs/ledger.md): with
// WCAG 1.4.12 text spacing, a large partial total once pushed the table past the inspector and
// cut its costs, which a keyboard user could not scroll to.
describe("ledger.css lets the tables shrink to the inspector", () => {
  it("the cost cell wraps; amount and qualifier each stay whole", () => {
    const cost = rule(".ledger-table td.ledger-cost", ledgerCss);
    expect(cost).not.toMatch(/white-space:\s*nowrap/);
    expect(declaration(cost, "white-space")).toBe("normal");
    const parts = rule(".ledger-table .ledger-amount,\n.ledger-table .ledger-qualifier", ledgerCss);
    expect(declaration(parts, "white-space")).toBe("nowrap");
  });

  it("row headers break anywhere", () => {
    expect(declaration(rule('.ledger-table th[scope="row"]', ledgerCss), "overflow-wrap")).toBe(
      "anywhere",
    );
  });

  it("nothing else in ledger.css forbids wrapping or hides overflow", () => {
    const withoutParts = ledgerCss.replace(
      /\.ledger-table \.ledger-amount,\n\.ledger-table \.ledger-qualifier\s*\{[^}]*\}/,
      "",
    );
    expect(withoutParts).not.toMatch(/white-space:\s*nowrap/);
    expect(ledgerCss).not.toMatch(/overflow:\s*hidden|text-overflow/);
  });
});

describe("axe-core: the ledger panel", () => {
  it("has no WCAG 2.1 A or AA failures for the session, with an unpriced model", async () => {
    render(withClock(<Inspector model={withUnpriced()} selected={null} onSelect={() => {}} />));
    expect(await axeProblems()).toEqual([]);
  });

  it("has no WCAG 2.1 A or AA failures for an unpriced agent", async () => {
    render(withClock(<Inspector model={withUnpriced()} selected="a2" onSelect={() => {}} />));
    expect(await axeProblems()).toEqual([]);
  });

  it("has no WCAG 2.1 A or AA failures for the session with the cache-write split", async () => {
    render(withClock(<Inspector model={withMixedSplit()} selected={null} onSelect={() => {}} />));
    expect(screen.getAllByRole("row", { name: /5-minute cache/ }).length).toBeGreaterThan(0);
    expect(await axeProblems()).toEqual([]);
  });

  it("has no WCAG 2.1 A or AA failures for an agent with the split and one without", async () => {
    const { unmount } = render(
      withClock(<Inspector model={withMixedSplit()} selected="main" onSelect={() => {}} />),
    );
    expect(await axeProblems()).toEqual([]);
    unmount();
    render(withClock(<Inspector model={withMixedSplit()} selected="a1" onSelect={() => {}} />));
    expect(screen.getByText(/^Cache writes are priced at the 5-minute cache price/)).toBeDefined();
    expect(await axeProblems()).toEqual([]);
  });

  it("has no WCAG 2.1 A or AA failures with per-reply models and a partial agent", async () => {
    render(
      withClock(
        <Inspector model={withReplyModels("unpriced")} selected="a1" onSelect={() => {}} />,
      ),
    );
    expect(screen.getByText(/^Not priced: replies of this agent used/)).toBeDefined();
    expect(await axeProblems()).toEqual([]);
  });

  it("has no WCAG 2.1 A or AA failures for the demo session", async () => {
    render(withClock(<Inspector model={DEMO} selected={null} onSelect={() => {}} />));
    expect(await axeProblems()).toEqual([]);
  });
});
