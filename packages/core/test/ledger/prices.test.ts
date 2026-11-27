// Ticket #26: the default price table, its checks and model matching. Every value is invented
// except the prices, which are copied from the source named in src/ledger/prices.ts.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CACHE_WRITE_LIFETIMES,
  DEFAULT_CACHE_WRITE_LIFETIME,
  DEFAULT_PRICE_TABLE,
  PRICES_READ_ON,
  PRICES_SOURCE_NAME,
  checkPriceTable,
  findModelPrice,
  formatPricePerMillion,
  perMillion,
  type ModelPrice,
  type PriceTable,
} from "../../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("perMillion", () => {
  it("reads a dollar price as whole micro-dollars, with no binary fraction", () => {
    expect(perMillion("4")).toBe(4_000_000);
    expect(perMillion("0.125")).toBe(125_000);
    expect(perMillion("18.75")).toBe(18_750_000);
    expect(perMillion("0.01")).toBe(10_000);
    expect(perMillion("0.000001")).toBe(1);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "-1", "$4", "1e3", "0.0000001", "4.", " 4"]) {
      expect(() => perMillion(bad)).toThrow(TypeError);
    }
  });
});

describe("DEFAULT_PRICE_TABLE", () => {
  const models = DEFAULT_PRICE_TABLE.models;

  it("names its date and source", () => {
    expect(DEFAULT_PRICE_TABLE.readOn).toBe(PRICES_READ_ON);
    expect(PRICES_READ_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DEFAULT_PRICE_TABLE.sourceName).toBe(PRICES_SOURCE_NAME);
  });

  it("passes its own check, with every id listed once", () => {
    expect(checkPriceTable(DEFAULT_PRICE_TABLE)).toBe(DEFAULT_PRICE_TABLE);
    const ids = models.flatMap((model) => model.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the documented cache write multipliers: 1.25x input for 5 minutes, 2x for 1 hour", () => {
    const all = models.flatMap((model) => [
      model.prices,
      ...(model.longPrompt ? [model.longPrompt.prices] : []),
    ]);
    for (const prices of all) {
      expect(prices.cacheWrite5m * 4).toBe(prices.input * 5);
      expect(prices.cacheWrite1h).toBe(prices.input * 2);
    }
  });

  it("covers every model id the fixtures use, except the invented and the undocumented ones", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-2",
    ]) {
      expect(findModelPrice(DEFAULT_PRICE_TABLE, id)).toBeDefined();
    }
    // An invented family, and a dated form the documentation does not name.
    expect(findModelPrice(DEFAULT_PRICE_TABLE, "claude-quartz-1-0")).toBeUndefined();
    expect(findModelPrice(DEFAULT_PRICE_TABLE, "claude-haiku-5-5-20260115")).toBeUndefined();
  });

  it("gives Claude Haiku 5.5 its long-prompt prices over 100,000 tokens", () => {
    const haiku = findModelPrice(DEFAULT_PRICE_TABLE, "claude-haiku-5-5") as ModelPrice;
    expect(haiku.longPrompt?.overPromptTokens).toBe(100_000);
    expect(haiku.prices.input).toBe(100_000);
    expect(haiku.longPrompt?.prices.input).toBe(500_000);
  });

  it("is the table docs/ledger.md prints, row for row", () => {
    // Prettier pads table cells to the column width; compare with runs of spaces collapsed.
    const doc = readFileSync(join(ROOT, "docs", "ledger.md"), "utf8").replace(/ {2,}/g, " ");
    expect(doc).toContain("27 Nov 2026");
    expect(PRICES_READ_ON).toBe("2026-11-27");
    for (const model of models) {
      const tiers = model.longPrompt
        ? [
            {
              note: ` (prompt up to ${model.longPrompt.overPromptTokens.toLocaleString("en-US")} tokens)`,
              p: model.prices,
            },
            {
              note: ` (prompt over ${model.longPrompt.overPromptTokens.toLocaleString("en-US")} tokens)`,
              p: model.longPrompt.prices,
            },
          ]
        : [{ note: "", p: model.prices }];
      for (const { note, p } of tiers) {
        const cells = [
          `${model.label}${note}`,
          model.ids.map((id) => `\`${id}\``).join(", "),
          formatPricePerMillion(p.input),
          formatPricePerMillion(p.output),
          formatPricePerMillion(p.cacheRead),
          formatPricePerMillion(p.cacheWrite5m),
          formatPricePerMillion(p.cacheWrite1h),
        ];
        expect(doc).toContain(`| ${cells.join(" | ")} |`);
      }
    }
  });
});

describe("findModelPrice", () => {
  it("matches the exact id only", () => {
    expect(findModelPrice(DEFAULT_PRICE_TABLE, "claude-haiku-4-5")?.label).toBe("Claude Haiku 4.5");
    expect(findModelPrice(DEFAULT_PRICE_TABLE, "claude-haiku-4-5-20251001")?.label).toBe(
      "Claude Haiku 4.5",
    );
    for (const near of [
      "claude-opus",
      "opus",
      "Claude-Opus-5-5",
      "claude-opus-5-5 ",
      "claude-opus-5-5-x",
    ]) {
      expect(findModelPrice(DEFAULT_PRICE_TABLE, near)).toBeUndefined();
    }
  });

  it("treats a missing model as unpriced", () => {
    expect(findModelPrice(DEFAULT_PRICE_TABLE, null)).toBeUndefined();
  });
});

describe("checkPriceTable", () => {
  const good: PriceTable = {
    readOn: "2001-01-01",
    sourceName: "an invented price list",
    models: [
      {
        ids: ["example-model-1"],
        label: "Example 1",
        prices: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 3, cacheWrite1h: 4 },
        longPrompt: {
          overPromptTokens: 10,
          prices: { input: 2, output: 4, cacheRead: 0, cacheWrite5m: 6, cacheWrite1h: 8 },
        },
      },
    ],
  };

  it("accepts a valid table and returns it", () => {
    expect(checkPriceTable(good)).toBe(good);
  });

  it("rejects each wrong shape with fixed text that never quotes a value", () => {
    const model = good.models[0] as ModelPrice;
    const bad: unknown[] = [
      null,
      [],
      { ...good, readOn: 1 },
      { ...good, sourceName: null },
      { ...good, models: {} },
      { ...good, models: [1] },
      { ...good, models: [{ ...model, label: 2 }] },
      { ...good, models: [{ ...model, ids: [] }] },
      { ...good, models: [{ ...model, ids: [""] }] },
      { ...good, models: [model, { ...model, label: "Again" }] },
      { ...good, models: [{ ...model, prices: null }] },
      { ...good, models: [{ ...model, prices: { ...model.prices, input: 0.5 } }] },
      { ...good, models: [{ ...model, prices: { ...model.prices, output: -1 } }] },
      { ...good, models: [{ ...model, prices: { ...model.prices, cacheRead: "1" } }] },
      { ...good, models: [{ ...model, longPrompt: 3 }] },
      {
        ...good,
        models: [{ ...model, longPrompt: { overPromptTokens: -1, prices: model.prices } }],
      },
      { ...good, models: [{ ...model, longPrompt: { overPromptTokens: 1, prices: {} } }] },
    ];
    for (const value of bad) {
      expect(() => checkPriceTable(value)).toThrow(TypeError);
    }
    const message = (() => {
      try {
        checkPriceTable({
          ...good,
          models: [{ ...model, ids: ["PLANTED-invented", "PLANTED-invented"] }],
        });
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toBe("PriceTable: a model id is listed twice");
  });
});

describe("cache write lifetimes", () => {
  it("defaults to the 5-minute price", () => {
    expect(CACHE_WRITE_LIFETIMES).toEqual(["5m", "1h"]);
    expect(DEFAULT_CACHE_WRITE_LIFETIME).toBe("5m");
  });
});

describe("formatPricePerMillion", () => {
  it("writes a price the way the pricing page does", () => {
    expect(formatPricePerMillion(4_000_000)).toBe("$4");
    expect(formatPricePerMillion(125_000)).toBe("$0.125");
    expect(formatPricePerMillion(18_750_000)).toBe("$18.75");
    expect(formatPricePerMillion(200_000)).toBe("$0.20");
    expect(formatPricePerMillion(10_000)).toBe("$0.01");
    expect(formatPricePerMillion(2_500_000)).toBe("$2.50");
    expect(formatPricePerMillion(0)).toBe("$0");
  });
});
