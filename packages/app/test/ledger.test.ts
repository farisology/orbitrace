// The inspector ledger's words (#26). Every replay here is invented.
import { describe, expect, it } from "vitest";
import { sessionLedger, type ReplayModel, type ReplaySubagent } from "@orbitrace/core";
import {
  NOT_PRICED,
  agentLedger,
  agentUnpricedNote,
  classCostText,
  costParts,
  costText,
  PARTIAL,
  estimateNote,
  ledgerOf,
  modelText,
  readOnText,
  sessionUnpricedNote,
} from "../src/ledger";
import { DEMO, makeModel } from "./helpers";

/** `makeModel` with agent a2 on an invented model id the price table does not list. */
function withUnpriced(): ReplayModel {
  const model = makeModel();
  const [main, a1, a2] = model.agents as unknown as [
    ReplayModel["agents"][0],
    ReplaySubagent,
    ReplaySubagent,
  ];
  return { ...model, agents: [main, a1, { ...a2, model: "claude-quartz-1-0", family: "quartz" }] };
}

describe("ledgerOf", () => {
  it("is core's sessionLedger, computed once per snapshot", () => {
    const model = makeModel();
    const first = ledgerOf(model);
    expect(ledgerOf(model)).toBe(first);
    expect(first).toEqual(sessionLedger(model));
    expect(ledgerOf(makeModel())).not.toBe(first);
  });

  it("finds an agent's entry", () => {
    const ledger = ledgerOf(makeModel());
    expect(agentLedger(ledger, "a1")?.callsign).toBe("widget-explorer");
    expect(agentLedger(ledger, "a9")).toBeUndefined();
  });

  it("prices the whole demo session", () => {
    expect(ledgerOf(DEMO).session.pricing).toBe("priced");
  });
});

describe("cost text", () => {
  it("labels a partial total and never prices an unpriced entry", () => {
    const ledger = ledgerOf(withUnpriced());
    expect(costText(ledger.session)).toMatch(/^(\$\d+\.\d\d|< \$0\.01) \(partial\)$/);
    const quartz = agentLedger(ledger, "a2")!;
    expect(costText(quartz)).toBe(NOT_PRICED);
    expect(classCostText(quartz, "output")).toBe(NOT_PRICED);
    const main = agentLedger(ledger, "main")!;
    expect(costText(main)).toMatch(/^(\$\d+\.\d\d|< \$0\.01)$/);
    expect(classCostText(main, "input")).toMatch(/^(\$\d+\.\d\d|< \$0\.01)$/);
  });
});

describe("costParts", () => {
  it("splits a total into the amount and the partial qualifier", () => {
    const ledger = ledgerOf(withUnpriced());
    const session = costParts(ledger.session);
    expect(session.amount).toMatch(/^(\$\d+\.\d\d|< \$0\.01)$/);
    expect(session.qualifier).toBe(PARTIAL);
    expect(costText(ledger.session)).toBe(`${session.amount} ${PARTIAL}`);
    expect(costParts(agentLedger(ledger, "a2")!)).toEqual({ amount: NOT_PRICED, qualifier: null });
    const main = costParts(agentLedger(ledger, "main")!);
    expect(main.qualifier).toBeNull();
    expect(main.amount).toBe(costText(agentLedger(ledger, "main")!));
  });
});

describe("readOnText", () => {
  it("writes a date the same in every locale", () => {
    expect(readOnText("2026-11-27")).toBe("27 Nov 2026");
    expect(readOnText("2001-01-05")).toBe("5 Jan 2001");
    expect(readOnText("2001-13-05")).toBe("2001-13-05");
    expect(readOnText("someday")).toBe("someday");
  });
});

describe("notes", () => {
  it("says every cost is an estimate, from where and when, and what is left out", () => {
    const note = estimateNote(ledgerOf(makeModel()));
    expect(note).toContain("estimates in US dollars");
    expect(note).toContain("an agent that switched models is counted and priced entirely");
    expect(note).toContain("Anthropic's model pricing page");
    expect(note).toContain("27 Nov 2026");
    expect(note).toContain("5-minute");
    expect(note).toContain("not included");
    expect(estimateNote({ ...ledgerOf(makeModel()), cacheWrite: "1h" })).toContain("1-hour");
  });

  it("names each unpriced model with its tokens, and says the session total is partial", () => {
    expect(sessionUnpricedNote(ledgerOf(makeModel()))).toBeNull();
    const note = sessionUnpricedNote(ledgerOf(withUnpriced()));
    expect(note).toBe(
      "Not priced: claude-quartz-1-0 (200 tokens). The price table does not cover this model. " +
        "Their tokens are counted; their cost is not guessed and is left out, so the session " +
        "estimate is partial.",
    );
  });

  it("says when nothing in the session is priced", () => {
    const ledger = sessionLedger(makeModel(), {
      prices: { readOn: "2001-01-01", sourceName: "an invented list", models: [] },
    });
    expect(sessionUnpricedNote(ledger)).toContain("these models");
    expect(sessionUnpricedNote(ledger)).toContain("so there is no session estimate.");
  });

  it("explains an unpriced agent, with a known or an unknown model", () => {
    const ledger = ledgerOf(withUnpriced());
    expect(agentUnpricedNote(agentLedger(ledger, "main")!)).toBeNull();
    expect(agentUnpricedNote(agentLedger(ledger, "a2")!)).toBe(
      "Not priced: claude-quartz-1-0 is not in the price table. Its tokens are counted; its cost is not guessed.",
    );
    const entry = { ...agentLedger(ledger, "a2")!, model: null };
    expect(agentUnpricedNote(entry)).toContain("This agent's model is unknown");
  });

  it("names a missing model by its family", () => {
    expect(modelText({ model: null, family: "opus" })).toBe("unrecorded model (opus family)");
    expect(modelText({ model: "claude-opus-5-5", family: "opus" })).toBe("claude-opus-5-5");
  });
});
