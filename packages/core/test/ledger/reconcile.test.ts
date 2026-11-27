// Ticket #26, "Done when: totals reconcile with the transcripts". For every committed synthetic
// fixture session: the ledger's token totals equal what the transcripts hold (the manifest's
// expected usage, counted by the generator that wrote them), the replay's own totals, and the
// sums of its model and agent entries; each cost is the sum of its parts; and unpriced models
// show their tokens and no cost. The sessions are invented (fixtures/README.md).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_TABLE,
  addCost,
  buildReplay,
  findModelPrice,
  parseSession,
  replyCost,
  sessionLedger,
  sumEntries,
  type LedgerCost,
  type LedgerTokens,
  type ReplayModel,
  type ReplayTotals,
} from "../../src/index.js";
import { loadCorpus, toInput } from "../export/audit-corpus.js";
import { manifestSessions, readReplay, type ManifestUsage } from "./helpers.js";

const fromUsage = (usage: ManifestUsage): LedgerTokens => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheCreation: usage.cache_creation_input_tokens,
});

const fromTotals = (totals: ReplayTotals): LedgerTokens => ({
  input: totals.inputTokens,
  output: totals.outputTokens,
  cacheRead: totals.cacheReadTokens,
  cacheCreation: totals.cacheCreationTokens,
});

const ZERO: LedgerCost = { input: 0n, output: 0n, cacheRead: 0n, cacheCreation: 0n, total: 0n };

const sessions = manifestSessions();
const minimal = readReplay("replays/minimal.replay.json");

describe("ledger reconciliation over every fixture", () => {
  it("covers every fixture session", () => {
    expect(sessions.length).toBeGreaterThanOrEqual(9);
  });

  describe.each(sessions)("$name", (session) => {
    const replay = readReplay(session.goldenReplay);
    const ledger = sessionLedger(replay);

    it("session tokens equal the transcripts' usage and the replay's totals", () => {
      expect(ledger.session.tokens).toEqual(fromUsage(session.expected.totals.usage));
      expect(ledger.session.tokens).toEqual(fromTotals(replay.totals));
      expect(ledger.session.replies).toBe(session.expected.totals.replies);
    });

    it("each agent's tokens equal its replay totals, and agents and models sum to the session", () => {
      replay.agents.forEach((agent, index) => {
        expect(ledger.byAgent[index]?.tokens).toEqual(fromTotals(agent.totals));
      });
      expect(sumEntries(ledger.byAgent)).toEqual(ledger.session);
      expect(sumEntries(ledger.byModel)).toEqual(ledger.session);
    });

    it("each model's tokens equal the transcripts' usage of the agents on that model", () => {
      const expected = new Map<string, LedgerTokens>();
      for (const agent of session.expected.agents) {
        const key = agent.model ?? "null";
        const prev = expected.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        const add = fromUsage(agent.usage);
        expected.set(key, {
          input: prev.input + add.input,
          output: prev.output + add.output,
          cacheRead: prev.cacheRead + add.cacheRead,
          cacheCreation: prev.cacheCreation + add.cacheCreation,
        });
      }
      const actual = new Map(ledger.byModel.map((entry) => [entry.model ?? "null", entry.tokens]));
      expect(actual).toEqual(expected);
    });

    it("each cost is the sum of its replies and of its classes", () => {
      let total = ZERO;
      for (const agent of replay.agents) {
        const price = findModelPrice(DEFAULT_PRICE_TABLE, agent.model);
        if (price === undefined) continue;
        for (const r of agent.replies) total = addCost(total, replyCost(r, price));
      }
      expect(ledger.session.cost).toEqual(total);
      const { cost } = ledger.session;
      expect(cost.input + cost.output + cost.cacheRead + cost.cacheCreation).toBe(cost.total);
    });

    it("prices exactly the models the table lists, and marks the rest", () => {
      const listed = (model: string | null) =>
        findModelPrice(DEFAULT_PRICE_TABLE, model) !== undefined;
      expect(ledger.byModel.map((entry) => entry.pricing)).toEqual(
        ledger.byModel.map((entry) => (listed(entry.model) ? "priced" : "unpriced")),
      );
      const unpriced = ledger.byModel.filter((entry) => !listed(entry.model));
      for (const entry of unpriced) {
        expect(entry.cost.total).toBe(0n);
        expect(entry.unpricedTokens).toEqual(entry.tokens);
      }
      expect(ledger.session.pricing).toBe(unpriced.length > 0 ? "partial" : "priced");
    });
  });

  it("marks the fixtures with an invented or undocumented model id as partial", () => {
    const partial = sessions
      .filter(
        (session) => sessionLedger(readReplay(session.goldenReplay)).session.pricing === "partial",
      )
      .map((session) => session.name)
      .sort();
    expect(partial).toEqual(["mcp-tools", "unknown-lines"]);
  });

  it("reconciles the hand-written minimal replay too", () => {
    const ledger = sessionLedger(minimal);
    expect(ledger.session.tokens).toEqual(fromTotals(minimal.totals));
    expect(sumEntries(ledger.byAgent)).toEqual(ledger.session);
  });

  it("gives the same ledger from the transcripts as from the committed replay", async () => {
    const goldens = new Map(sessions.map((session) => [session.name, session.goldenReplay]));
    const fromTranscripts = new Map<string, unknown>();
    const fromGoldens = new Map<string, unknown>();
    for (const corpus of loadCorpus()) {
      const built: ReplayModel = buildReplay(await parseSession(toInput(corpus)));
      fromTranscripts.set(corpus.name, sessionLedger(built));
      fromGoldens.set(corpus.name, sessionLedger(readReplay(goldens.get(corpus.name) as string)));
    }
    expect(fromTranscripts.size).toBe(sessions.length);
    expect(fromTranscripts).toEqual(fromGoldens);
  });
});
