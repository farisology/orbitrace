// Ticket #26: the ledger arithmetic, unpriced models and caller tables. Every replay here is
// invented; the expected costs are worked out by hand from the default table's prices.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_TABLE,
  addCost,
  addTokens,
  agentEntry,
  exportReplay,
  findModelPrice,
  pricesForReply,
  replyCost,
  replyTokens,
  sessionLedger,
  sumEntries,
  totalTokens,
  type LedgerEntry,
  type ModelPrice,
  type PriceTable,
  type ReplayModel,
} from "../../src/index.js";
import { replayOf, reply } from "./helpers.js";

const OPUS = findModelPrice(DEFAULT_PRICE_TABLE, "claude-opus-5-5") as ModelPrice;
const HAIKU = findModelPrice(DEFAULT_PRICE_TABLE, "claude-haiku-5-5") as ModelPrice;

describe("replyTokens", () => {
  it("reads the four classes and keeps whole counts of at least 0", () => {
    expect(replyTokens(reply(1, 2, 3, 4))).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
    });
    expect(replyTokens(reply(-5, Number.NaN, 2.7, Infinity))).toEqual({
      input: 0,
      output: 0,
      cacheRead: 2,
      cacheCreation: 0,
    });
  });
});

describe("replyCost", () => {
  it("prices each class exactly, in picodollars", () => {
    // Claude Opus 5.5: $4 input, $20 output, $0.20 cache read, $5 5m write, $8 1h write.
    const cost = replyCost(reply(1000, 200, 5000, 300), OPUS);
    expect(cost).toEqual({
      input: 4_000_000_000n,
      output: 4_000_000_000n,
      cacheRead: 1_000_000_000n,
      cacheCreation: 1_500_000_000n,
      total: 10_500_000_000n,
    });
  });

  it("uses the 1-hour cache write price when asked", () => {
    const cost = replyCost(reply(1000, 200, 5000, 300), OPUS, "1h");
    expect(cost.cacheCreation).toBe(2_400_000_000n);
    expect(cost.total).toBe(11_400_000_000n);
  });

  it("stays exact past the largest safe double", () => {
    const opus41 = findModelPrice(DEFAULT_PRICE_TABLE, "claude-opus-4-1-20250805") as ModelPrice;
    // 2,000,000,000 output tokens at $75 per million is $150,000: 1.5e17 picodollars.
    expect(replyCost(reply(0, 2_000_000_000, 0, 0), opus41).total).toBe(150_000_000_000_000_000n);
    expect(150_000_000_000_000_000 > Number.MAX_SAFE_INTEGER).toBe(true);
  });
});

describe("pricesForReply", () => {
  it("switches Claude Haiku 5.5 to its long-prompt prices only over 100,000 prompt tokens", () => {
    const at = replyTokens(reply(100, 10, 99_800, 100));
    const over = replyTokens(reply(101, 10, 99_800, 100));
    expect(pricesForReply(HAIKU, at)).toBe(HAIKU.prices);
    expect(pricesForReply(HAIKU, over)).toBe(HAIKU.longPrompt?.prices);
    expect(replyCost(reply(100, 10, 99_800, 100), HAIKU).total).toBe(1_025_500_000n);
    expect(replyCost(reply(101, 10, 99_800, 100), HAIKU).total).toBe(5_128_000_000n);
  });

  it("does not count output tokens towards the prompt", () => {
    expect(pricesForReply(HAIKU, replyTokens(reply(10, 500_000, 0, 0)))).toBe(HAIKU.prices);
  });

  it("uses the base prices for a model with one set", () => {
    expect(pricesForReply(OPUS, replyTokens(reply(900_000, 0, 0, 0)))).toBe(OPUS.prices);
  });
});

describe("sums", () => {
  it("adds tokens, costs and totals", () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 };
    expect(addTokens(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheCreation: 8 });
    expect(totalTokens(a)).toBe(10);
    const c = { input: 1n, output: 2n, cacheRead: 3n, cacheCreation: 4n, total: 10n };
    expect(addCost(c, c)).toEqual({
      input: 2n,
      output: 4n,
      cacheRead: 6n,
      cacheCreation: 8n,
      total: 20n,
    });
  });

  it("works out pricing again from the reply counts", () => {
    const zero = { input: 0n, output: 0n, cacheRead: 0n, cacheCreation: 0n, total: 0n };
    const t = { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 };
    const none = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const priced: LedgerEntry = {
      replies: 1,
      tokens: t,
      cost: { ...zero, input: 4n, total: 4n },
      unpricedReplies: 0,
      unpricedTokens: none,
      pricing: "priced",
    };
    const unpriced: LedgerEntry = {
      replies: 1,
      tokens: t,
      cost: zero,
      unpricedReplies: 1,
      unpricedTokens: t,
      pricing: "unpriced",
    };
    expect(sumEntries([priced, unpriced])).toMatchObject({
      replies: 2,
      unpricedReplies: 1,
      pricing: "partial",
      tokens: { input: 2 },
      unpricedTokens: { input: 1 },
      cost: { total: 4n },
    });
    expect(sumEntries([unpriced, unpriced]).pricing).toBe("unpriced");
    expect(sumEntries([]).pricing).toBe("priced");
  });
});

describe("agentEntry", () => {
  it("prices every reply of an agent at its model", () => {
    const model = replayOf({
      model: "claude-opus-5-5",
      family: "opus",
      replies: [reply(1000, 200, 5000, 300), reply(1000, 200, 5000, 300)],
    });
    const entry = agentEntry(model.agents[0]);
    expect(entry).toMatchObject({
      id: "main",
      callsign: "main",
      label: "Claude Opus 5.5",
      replies: 2,
      pricing: "priced",
      tokens: { input: 2000, output: 400, cacheRead: 10_000, cacheCreation: 600 },
      cost: { total: 21_000_000_000n },
      unpricedReplies: 0,
    });
  });

  it("counts an unpriced agent's tokens and leaves its cost at 0", () => {
    const model = replayOf({
      model: "claude-quartz-1-0",
      family: "quartz",
      replies: [reply(5, 6, 7, 8)],
    });
    const entry = agentEntry(model.agents[0]);
    expect(entry.pricing).toBe("unpriced");
    expect(entry.label).toBeNull();
    expect(entry.tokens).toEqual(entry.unpricedTokens);
    expect(entry.cost.total).toBe(0n);
  });

  it("calls an agent with no replies priced, at 0", () => {
    const model = replayOf({ model: null, family: "unknown", replies: [] });
    expect(agentEntry(model.agents[0])).toMatchObject({
      replies: 0,
      pricing: "priced",
      cost: { total: 0n },
    });
  });
});

function threeModelSession(): ReplayModel {
  return replayOf(
    { model: "claude-opus-5-5", family: "opus", replies: [reply(1000, 200, 5000, 300)] },
    { model: "claude-quartz-1-0", family: "quartz", replies: [reply(10, 20, 30, 40)] },
    { model: "claude-opus-5-5", family: "opus", replies: [reply(1000, 200, 5000, 300)] },
    { model: null, family: "opus", replies: [reply(1, 1, 1, 1)] },
  );
}

describe("sessionLedger", () => {
  it("totals the session, each model and each agent, and they agree", () => {
    const ledger = sessionLedger(threeModelSession());
    expect(ledger.byAgent.map((entry) => entry.id)).toEqual(["main", "a1", "a2", "a3"]);
    expect(ledger.byModel.map((entry) => [entry.model, entry.family, entry.agents])).toEqual([
      ["claude-opus-5-5", "opus", ["main", "a2"]],
      ["claude-quartz-1-0", "quartz", ["a1"]],
      [null, "opus", ["a3"]],
    ]);
    expect(ledger.byModel.map((entry) => entry.pricing)).toEqual([
      "priced",
      "unpriced",
      "unpriced",
    ]);
    expect(ledger.session.tokens).toEqual({
      input: 2011,
      output: 421,
      cacheRead: 10_031,
      cacheCreation: 641,
    });
    expect(ledger.session.unpricedTokens).toEqual({
      input: 11,
      output: 21,
      cacheRead: 31,
      cacheCreation: 41,
    });
    expect(ledger.session.cost.total).toBe(21_000_000_000n);
    expect(ledger.session.pricing).toBe("partial");
    expect(sumEntries(ledger.byModel)).toEqual(ledger.session);
    expect(sumEntries(ledger.byAgent)).toEqual(ledger.session);
  });

  it("says which prices and cache lifetime it used", () => {
    const ledger = sessionLedger(threeModelSession());
    expect(ledger.cacheWrite).toBe("5m");
    expect(ledger.pricesReadOn).toBe(DEFAULT_PRICE_TABLE.readOn);
    expect(ledger.pricesSource).toBe(DEFAULT_PRICE_TABLE.sourceName);
    expect(
      sessionLedger(threeModelSession(), { cacheWrite: "1h" }).session.cost.cacheCreation,
    ).toBe(2n * 300n * 8_000_000n);
  });

  it("uses a table the caller passes, checked first", () => {
    const table: PriceTable = {
      readOn: "2001-01-01",
      sourceName: "an invented price list",
      models: [
        {
          ids: ["claude-quartz-1-0"],
          label: "Quartz",
          prices: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        },
      ],
    };
    const ledger = sessionLedger(threeModelSession(), { prices: table });
    expect(ledger.pricesSource).toBe("an invented price list");
    expect(ledger.byModel.map((entry) => entry.pricing)).toEqual([
      "unpriced",
      "priced",
      "unpriced",
    ]);
    expect(ledger.session.cost.total).toBe(10n * 1_000_000n);
    expect(() =>
      sessionLedger(threeModelSession(), {
        prices: { ...table, models: "x" } as unknown as PriceTable,
      }),
    ).toThrow(TypeError);
  });

  it("prices nothing with an empty table, and says so", () => {
    const ledger = sessionLedger(threeModelSession(), {
      prices: { readOn: "2001-01-01", sourceName: "none", models: [] },
    });
    expect(ledger.session.pricing).toBe("unpriced");
    expect(ledger.session.cost.total).toBe(0n);
    expect(ledger.session.tokens).toEqual(ledger.session.unpricedTokens);
  });

  it("rejects an unknown cache lifetime", () => {
    expect(() =>
      sessionLedger(threeModelSession(), { cacheWrite: "1d" as unknown as "5m" }),
    ).toThrow('SessionLedgerOptions.cacheWrite must be "5m" or "1h"');
  });
});

describe("opaque-name exports", () => {
  it("leaves an agent unpriced when the export dropped its model id, whatever its family", () => {
    // `names: "opaque"` keeps a known Claude model id and writes `null` for any other, keeping a
    // known family. A family covers several model generations at different prices, so a
    // family alone is never priced.
    const model = replayOf(
      { model: "claude-opus-5-5", family: "opus", replies: [reply(1000, 200, 5000, 300)] },
      { model: "claude-opus-5-5-preview", family: "opus", replies: [reply(10, 20, 30, 40)] },
    );
    const opaque = JSON.parse(exportReplay(model, { names: "opaque" }).data) as ReplayModel;
    expect(opaque.agents[1]?.model).toBeNull();
    expect(opaque.agents[1]?.family).toBe("opus");
    const ledger = sessionLedger(opaque);
    expect(ledger.byAgent.map((entry) => entry.pricing)).toEqual(["priced", "unpriced"]);
    expect(ledger.session.pricing).toBe("partial");
    expect(ledger.session.tokens).toEqual(sessionLedger(model).session.tokens);
    expect(ledger.session.cost).toEqual(sessionLedger(model).session.cost);
  });
});
