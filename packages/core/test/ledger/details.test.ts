// Ticket #191 (and #190): the ledger prices cache writes by their recorded lifetime and each
// reply at its own recorded model, and falls back, saying so, when a replay has neither. Every
// replay here is invented; the expected costs are worked out by hand from the default table.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_TABLE,
  addCacheWrites,
  agentEntry,
  cacheWriteBasis,
  exportReplay,
  findModelPrice,
  replyCacheWriteTokens,
  replyCost,
  sessionLedger,
  sumEntries,
  type LedgerEntry,
  type ModelPrice,
  type ReplayAgent,
  type ReplayModel,
  type ReplayReplyDetails,
  type ReplayReplyWithDetails,
} from "../../src/index.js";
import { replayOf, reply } from "./helpers.js";

const OPUS = findModelPrice(DEFAULT_PRICE_TABLE, "claude-opus-5-5") as ModelPrice;

/** `reply(...)` with in-memory details. */
function withDetails(
  base: ReplayReplyWithDetails,
  details: ReplayReplyDetails,
): ReplayReplyWithDetails {
  return { ...base, ...details };
}

/** The invariant of `LedgerCacheWrites`: the parts give back the cache creation total. */
function expectWritesAddUp(entry: LedgerEntry): void {
  const w = entry.cacheWrites;
  expect(w.recorded5m + w.recorded1h + w.unrecorded - w.overTotal).toBe(entry.tokens.cacheCreation);
  expect(w.cost5m + w.cost1h + w.costUnrecorded).toBe(entry.cost.cacheCreation);
}

describe("replyCacheWriteTokens", () => {
  it("calls every cache creation token unrecorded when there is no split", () => {
    expect(replyCacheWriteTokens(reply(0, 0, 0, 300))).toEqual({
      recorded5m: 0,
      recorded1h: 0,
      unrecorded: 300,
      overTotal: 0,
      split: false,
    });
  });

  it("takes a split that adds up as recorded", () => {
    const split = withDetails(reply(0, 0, 0, 300), {
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 200,
    });
    expect(replyCacheWriteTokens(split)).toEqual({
      recorded5m: 100,
      recorded1h: 200,
      unrecorded: 0,
      overTotal: 0,
      split: true,
    });
  });

  it("counts a missing lifetime as 0 and keeps the rest of the total unrecorded", () => {
    const only1h = withDetails(reply(0, 0, 0, 300), { cacheWrite1hTokens: 120 });
    expect(replyCacheWriteTokens(only1h)).toMatchObject({
      recorded5m: 0,
      recorded1h: 120,
      unrecorded: 180,
      overTotal: 0,
    });
  });

  it("reports a split above the total, and never lowers either side", () => {
    const over = withDetails(reply(0, 0, 0, 100), {
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 80,
    });
    expect(replyCacheWriteTokens(over)).toMatchObject({
      recorded5m: 100,
      recorded1h: 80,
      unrecorded: 0,
      overTotal: 80,
    });
  });
});

describe("replyCost with a recorded split", () => {
  // Claude Opus 5.5: $5 per million for a 5-minute write, $8 for a 1-hour write.
  it("prices each lifetime at its own price", () => {
    const split = withDetails(reply(0, 0, 0, 300), {
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 200,
    });
    // 100 x 5,000,000 + 200 x 8,000,000 picodollars.
    expect(replyCost(split, OPUS).cacheCreation).toBe(2_100_000_000n);
    // The fallback lifetime does not touch a recorded split.
    expect(replyCost(split, OPUS, "1h").cacheCreation).toBe(2_100_000_000n);
  });

  it("prices the part of the total that the split does not cover at the fallback lifetime", () => {
    const under = withDetails(reply(0, 0, 0, 300), {
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 100,
    });
    expect(replyCost(under, OPUS).cacheCreation).toBe(500_000_000n + 800_000_000n + 500_000_000n);
    expect(replyCost(under, OPUS, "1h").cacheCreation).toBe(
      500_000_000n + 800_000_000n + 800_000_000n,
    );
  });

  it("prices a split above the total as recorded", () => {
    const over = withDetails(reply(0, 0, 0, 100), {
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 80,
    });
    expect(replyCost(over, OPUS).cacheCreation).toBe(500_000_000n + 640_000_000n);
  });

  it("prices a reply with no split as before", () => {
    expect(replyCost(reply(0, 0, 0, 300), OPUS).cacheCreation).toBe(1_500_000_000n);
    expect(replyCost(reply(0, 0, 0, 300), OPUS, "1h").cacheCreation).toBe(2_400_000_000n);
  });
});

describe("cacheWriteBasis", () => {
  const ledgerOf = (...replies: ReplayReplyWithDetails[]) =>
    sessionLedger(replayOf({ model: "claude-opus-5-5", family: "opus", replies })).session;

  it("says where the cache-write prices come from", () => {
    expect(cacheWriteBasis(ledgerOf(reply(1, 1, 1, 0)))).toBe("none");
    expect(cacheWriteBasis(ledgerOf(reply(1, 1, 1, 50)))).toBe("unrecorded");
    expect(
      cacheWriteBasis(ledgerOf(withDetails(reply(1, 1, 1, 50), { cacheWrite1hTokens: 50 }))),
    ).toBe("recorded");
    expect(
      cacheWriteBasis(
        ledgerOf(withDetails(reply(1, 1, 1, 50), { cacheWrite1hTokens: 50 }), reply(1, 1, 1, 9)),
      ),
    ).toBe("mixed");
    // A split of zeros on a reply with no cache writes records nothing to price.
    expect(
      cacheWriteBasis(
        ledgerOf(withDetails(reply(1, 1, 1, 0), { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 })),
      ),
    ).toBe("none");
  });
});

/** Main on Opus 5.5 with one reply on Haiku 5.5; a subagent on an invented model, one reply on Opus. */
function mixedModels(): ReplayModel {
  return replayOf(
    {
      model: "claude-opus-5-5",
      family: "opus",
      replies: [
        withDetails(reply(1000, 200, 5000, 300), {
          model: "claude-opus-5-5",
          cacheWrite5mTokens: 100,
          cacheWrite1hTokens: 200,
        }),
        withDetails(reply(1000, 200, 0, 0), { model: "claude-haiku-5-5" }),
        reply(10, 10, 0, 40),
      ],
    },
    {
      name: "widget-helper",
      model: "claude-quartz-1-0",
      family: "quartz",
      replies: [
        withDetails(reply(10, 20, 30, 40), { cacheWrite1hTokens: 40 }),
        withDetails(reply(100, 0, 0, 0), { model: "claude-opus-5-5" }),
      ],
    },
  );
}

describe("sessionLedger with reply details", () => {
  const ledger = sessionLedger(mixedModels());

  it("prices each reply at its own model and groups replies, not agents, by model", () => {
    expect(ledger.byModel.map((entry) => [entry.model, entry.family, entry.agents])).toEqual([
      ["claude-opus-5-5", "opus", ["main", "a1"]],
      ["claude-haiku-5-5", "haiku", ["main"]],
      ["claude-quartz-1-0", "quartz", ["a1"]],
    ]);
    expect(ledger.byModel.map((entry) => entry.replies)).toEqual([3, 1, 1]);
    expect(ledger.byModel.map((entry) => entry.pricing)).toEqual(["priced", "priced", "unpriced"]);
    // Haiku 5.5: 1,000 x $0.10 + 200 x $0.50 per million.
    expect(ledger.byModel[1]?.cost.total).toBe(100_000_000n + 100_000_000n);
    expect(ledger.byModel[1]?.label).toBe("Claude Haiku 5.5");
  });

  it("counts the replies priced at their own model", () => {
    expect(ledger.session.ownModelReplies).toBe(3);
    expect(ledger.byAgent.map((entry) => entry.ownModelReplies)).toEqual([2, 1]);
  });

  it("marks an agent partial when only some of its replies are priced, naming the models", () => {
    const helper = ledger.byAgent[1];
    expect(helper?.pricing).toBe("partial");
    expect(helper?.unpricedModels).toEqual(["claude-quartz-1-0"]);
    expect(helper?.label).toBeNull();
    // The one priced reply: 100 Opus 5.5 input tokens at $4 per million.
    expect(helper?.cost.total).toBe(400_000_000n);
    expect(ledger.byAgent[0]?.unpricedModels).toEqual([]);
    expect(ledger.byAgent[0]?.label).toBe("Claude Opus 5.5");
  });

  it("splits cache writes by lifetime and keeps the token totals the replay's own", () => {
    const writes = ledger.session.cacheWrites;
    expect(writes.recorded5m).toBe(100);
    expect(writes.recorded1h).toBe(240);
    expect(writes.unrecorded).toBe(40);
    expect(writes.overTotal).toBe(0);
    expect(ledger.session.tokens.cacheCreation).toBe(380);
    // Priced replies only: the quartz reply's 40 one-hour tokens are counted, not priced.
    expect(writes.cost5m).toBe(100n * 5_000_000n);
    expect(writes.cost1h).toBe(200n * 8_000_000n);
    expect(writes.costUnrecorded).toBe(40n * 5_000_000n);
    expect(cacheWriteBasis(ledger.session)).toBe("mixed");
    for (const entry of [ledger.session, ...ledger.byAgent, ...ledger.byModel]) {
      expectWritesAddUp(entry);
    }
  });

  it("still adds up: models and agents each sum to the session", () => {
    expect(sumEntries(ledger.byModel)).toEqual(ledger.session);
    expect(sumEntries(ledger.byAgent)).toEqual(ledger.session);
    expect(agentEntry(mixedModels().agents[1] as ReplayAgent)).toEqual(ledger.byAgent[1]);
  });

  it("prices unrecorded cache writes at the 1-hour price when asked, and says so", () => {
    const hour = sessionLedger(mixedModels(), { cacheWrite: "1h" });
    expect(hour.cacheWrite).toBe("1h");
    expect(hour.session.cacheWrites.costUnrecorded).toBe(40n * 8_000_000n);
    expect(hour.session.cacheWrites.cost1h).toBe(ledger.session.cacheWrites.cost1h);
  });

  it("reports a split above the total, prices it, and drops no token", () => {
    const over = sessionLedger(
      replayOf({
        model: "claude-opus-5-5",
        family: "opus",
        replies: [
          withDetails(reply(0, 0, 0, 100), { cacheWrite5mTokens: 100, cacheWrite1hTokens: 80 }),
        ],
      }),
    ).session;
    expect(over.tokens.cacheCreation).toBe(100);
    expect(over.cacheWrites.overTotal).toBe(80);
    expect(over.cost.cacheCreation).toBe(500_000_000n + 640_000_000n);
    expectWritesAddUp(over);
  });
});

describe("a replay file has no reply details", () => {
  it("falls back to the agent's model and the 5-minute price, and the ledger says so", () => {
    const exported = JSON.parse(exportReplay(mixedModels()).data) as ReplayModel;
    const ledger = sessionLedger(exported);
    expect(ledger.session.ownModelReplies).toBe(0);
    expect(cacheWriteBasis(ledger.session)).toBe("unrecorded");
    expect(ledger.session.cacheWrites.unrecorded).toBe(380);
    expect(ledger.cacheWrite).toBe("5m");
    // The same tokens as in memory; agents are grouped by their own model again.
    expect(ledger.session.tokens).toEqual(sessionLedger(mixedModels()).session.tokens);
    expect(ledger.byModel.map((entry) => entry.model)).toEqual([
      "claude-opus-5-5",
      "claude-quartz-1-0",
    ]);
  });
});

describe("addCacheWrites", () => {
  it("adds every count and cost", () => {
    const a = {
      recorded5m: 1,
      recorded1h: 2,
      unrecorded: 3,
      overTotal: 4,
      cost5m: 5n,
      cost1h: 6n,
      costUnrecorded: 7n,
    };
    expect(addCacheWrites(a, a)).toEqual({
      recorded5m: 2,
      recorded1h: 4,
      unrecorded: 6,
      overTotal: 8,
      cost5m: 10n,
      cost1h: 12n,
      costUnrecorded: 14n,
    });
  });
});
