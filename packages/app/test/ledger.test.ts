// The inspector ledger's words (#26, #191). Every replay here is invented.
import { describe, expect, it } from "vitest";
import { sessionLedger, type ReplayModel, type ReplaySubagent } from "@orbitrace/core";
import {
  NOT_PRICED,
  agentLedger,
  agentUnpricedNote,
  cacheWriteNote,
  cacheWriteRows,
  classCostText,
  costParts,
  costText,
  PARTIAL,
  estimateNote,
  ledgerOf,
  lifetimeText,
  modelSentence,
  modelText,
  readOnText,
  sessionUnpricedNote,
} from "../src/ledger";
import { DEMO, makeModel } from "./helpers";
import { withMixedSplit, withRecordedSplit, withReplyModels } from "./ledger-models";

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
    expect(note).toContain("not included");
  });

  it("says how each reply's model was chosen (#190)", () => {
    expect(modelSentence(ledgerOf(makeModel()).session)).toContain("one model per agent");
    const all = ledgerOf(withReplyModels("all"));
    expect(modelSentence(all.session)).toBe("Each reply is priced at the model it used.");
    expect(estimateNote(all)).toContain("Each reply is priced at the model it used.");
    const some = ledgerOf(withReplyModels("some"));
    expect(modelSentence(some.session)).toBe(
      "Replies that recorded their model are priced at it; the others are priced at their " +
        "agent's main model.",
    );
    // The agent view uses the agent's own entry.
    const main = agentLedger(some, "main")!;
    expect(estimateNote(some, main)).toContain("Each reply is priced at the model it used.");
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
    const entry = { ...agentLedger(ledger, "a2")!, model: null, unpricedModels: [null] };
    expect(agentUnpricedNote(entry)).toContain("This agent's model is unknown");
  });

  it("names the unpriced models of an agent whose replies used several", () => {
    const ledger = ledgerOf(withReplyModels("unpriced"));
    expect(agentUnpricedNote(agentLedger(ledger, "a1")!)).toBe(
      "Not priced: replies of this agent used claude-quartz-1-0, which the price table does not " +
        "cover. Their tokens are counted; their cost is not guessed, so the estimate is partial.",
    );
    const none = {
      ...agentLedger(ledger, "a1")!,
      pricing: "unpriced" as const,
      unpricedModels: ["claude-quartz-1-0", null],
    };
    expect(agentUnpricedNote(none)).toContain("claude-quartz-1-0, an unknown model");
    expect(agentUnpricedNote(none)).toContain("so there is no estimate.");
  });

  it("names a missing model by its family", () => {
    expect(modelText({ model: null, family: "opus" })).toBe("unrecorded model (opus family)");
    expect(modelText({ model: "claude-opus-5-5", family: "opus" })).toBe("claude-opus-5-5");
  });
});

describe("cache writes by lifetime (#191)", () => {
  it("writes the lifetime as the panel names it", () => {
    expect(lifetimeText("5m")).toBe("5-minute");
    expect(lifetimeText("1h")).toBe("1-hour");
  });

  it("says a replay with no recorded lifetime is priced at the 5-minute default", () => {
    const ledger = ledgerOf(makeModel());
    expect(cacheWriteRows(ledger.session)).toBeNull();
    expect(cacheWriteNote(ledger, ledger.session)).toBe(
      "Cache writes are priced at the 5-minute cache price, the default lifetime in Anthropic's " +
        "documentation, because this replay does not record which cache each write used (a " +
        "replay file never does). Where the other cache was used, the cache creation estimate " +
        "is low.",
    );
    const hour = sessionLedger(makeModel(), { cacheWrite: "1h" });
    expect(cacheWriteNote(hour, hour.session)).toContain("1-hour cache price, as chosen");
    expect(cacheWriteNote(hour, hour.session)).toContain("estimate is high.");
  });

  it("has no note when there are no cache writes", () => {
    const ledger = ledgerOf(makeModel());
    const entry = {
      ...ledger.session,
      cacheWrites: { ...ledger.session.cacheWrites, unrecorded: 0 },
    };
    expect(cacheWriteNote(ledger, entry)).toBeNull();
    expect(cacheWriteRows(entry)).toBeNull();
  });

  it("splits the cache creation row in two when every write has a recorded lifetime", () => {
    const ledger = ledgerOf(withRecordedSplit());
    const rows = cacheWriteRows(ledger.session)!;
    expect(rows.map((row) => [row.label, row.tokens])).toEqual([
      ["Cache creation, 5-minute cache", 40],
      ["Cache creation, 1-hour cache", 110],
    ]);
    for (const row of rows) expect(row.cost).toMatch(/^(\$\d+\.\d\d|< \$0\.01)$/);
    expect(cacheWriteNote(ledger, ledger.session)).toBe(
      "Cache writes are priced at the 5-minute or the 1-hour cache price, as the transcript " +
        "recorded for each.",
    );
  });

  it("adds a row and a note for the writes with no recorded lifetime", () => {
    const ledger = ledgerOf(withMixedSplit());
    const rows = cacheWriteRows(ledger.session)!;
    expect(rows.map((row) => [row.label, row.tokens])).toEqual([
      ["Cache creation, 5-minute cache", 20],
      ["Cache creation, 1-hour cache", 30],
      ["Cache creation, cache not recorded", 100],
    ]);
    const note = cacheWriteNote(ledger, ledger.session)!;
    expect(note).toContain("the other 100 cache creation tokens have no recorded cache");
    expect(note).toContain("5-minute cache price, the default lifetime");
  });

  it("reports a recorded split that goes past the total", () => {
    const ledger = ledgerOf(withRecordedSplit({ over: 25 }));
    expect(cacheWriteNote(ledger, ledger.session)).toContain(
      "The recorded caches add up to 25 tokens more than the cache creation total",
    );
  });

  it("writes not priced in every split row of an unpriced entry", () => {
    const ledger = sessionLedger(withRecordedSplit(), {
      prices: { readOn: "2001-01-01", sourceName: "an invented list", models: [] },
    });
    for (const row of cacheWriteRows(ledger.session)!) expect(row.cost).toBe(NOT_PRICED);
  });
});
