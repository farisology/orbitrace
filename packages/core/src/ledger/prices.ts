/**
 * Ticket #26. The price table the ledger uses by default, and its checks.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing ("Model pricing" table,
 * "Prompt caching" and "Long context pricing" sections), read on 27 Nov 2026. Model ids are
 * the Claude API ids from https://platform.claude.com/docs/en/models/overview, the model pages
 * under https://platform.claude.com/docs/en/models/ and
 * https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions, read the same
 * day. Prices are in US dollars per million tokens, written as the page writes them and kept
 * as integer micro-dollars per million tokens. docs/ledger.md lists the same source and date.
 *
 * Rules:
 * - A model is matched by its exact id, as Claude Code writes it in `message.model`. A dated
 *   form is listed only where the documentation names it (`claude-haiku-4-5-20251001` and its
 *   alias `claude-haiku-4-5`). No prefix, family or pattern match: an id the table does not list
 *   is unpriced, and its cost is never guessed.
 * - Cache writes have two prices, for the 5-minute and the 1-hour cache lifetime. A transcript
 *   (and so a replay) records only the total of cache creation tokens, not which lifetime was
 *   written. The ledger uses the 5-minute price by default, the lifetime the prompt caching
 *   documentation names as the default; a caller can choose the 1-hour price.
 * - Claude Haiku 5.5 has a second set of prices for a request whose prompt is over 100,000
 *   tokens. Its prompt length counts input, cache read and cache write tokens; each reply is
 *   one request and is priced on its own.
 * - The URL is kept out of the data on purpose: the public player build fails on any absolute
 *   URL in its bundle that is not an allowed link, and the table ships in the app.
 *
 * Browser-safe: no Node API.
 */

/** The date the default table was read from its source, `YYYY-MM-DD`. */
export const PRICES_READ_ON = "2026-11-27";

/** Where the default table comes from, in words (the URL is in this file's header and docs). */
export const PRICES_SOURCE_NAME = "Anthropic's model pricing page";

/** Cache lifetime a cache write was priced at. `5m` is the documented default. */
export type CacheWriteLifetime = "5m" | "1h";

/** The values of `CacheWriteLifetime`. */
export const CACHE_WRITE_LIFETIMES: readonly CacheWriteLifetime[] = ["5m", "1h"];

/** The lifetime the ledger prices cache writes at when the caller does not choose. */
export const DEFAULT_CACHE_WRITE_LIFETIME: CacheWriteLifetime = "5m";

/**
 * Prices of one model, each in integer micro-dollars per million tokens: $4 / MTok is
 * `4_000_000`, $0.125 / MTok is `125_000`.
 */
export interface TokenPrices {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** A write to the 5-minute prompt cache. */
  readonly cacheWrite5m: number;
  /** A write to the 1-hour prompt cache. */
  readonly cacheWrite1h: number;
}

/** A second set of prices for a request whose prompt is longer than `overPromptTokens`. */
export interface LongPromptPrices {
  /** Prompt length (input plus cache read plus cache write tokens) above which these apply. */
  readonly overPromptTokens: number;
  readonly prices: TokenPrices;
}

/** One priced model. */
export interface ModelPrice {
  /** Model ids exactly as transcripts write them, such as `claude-opus-5-5`. */
  readonly ids: readonly string[];
  /** Display name, such as `Claude Opus 5.5`. */
  readonly label: string;
  readonly prices: TokenPrices;
  readonly longPrompt?: LongPromptPrices;
}

/** A price table: a list of models, the date it was read and where from. */
export interface PriceTable {
  /** `YYYY-MM-DD`. */
  readonly readOn: string;
  /** Where the prices come from, in words. Shown next to every estimate. */
  readonly sourceName: string;
  readonly models: readonly ModelPrice[];
}

const DECIMAL = /^(\d{1,7})(?:\.(\d{1,6}))?$/;

/**
 * A price as the pricing page writes it (`"4"`, `"0.125"`, `"18.75"`, in dollars per million
 * tokens) as integer micro-dollars per million tokens. Parsed from the text, so no binary
 * fraction is ever involved. Throws a `TypeError` for anything that is not a plain decimal
 * with at most six decimals.
 */
export function perMillion(dollars: string): number {
  const match = DECIMAL.exec(dollars);
  if (match === null) throw new TypeError("A price must be a decimal with at most six decimals");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  return whole * 1_000_000 + fraction;
}

/** Prices in the order the pricing page lists them: input, 5m write, 1h write, read, output. */
function row(
  input: string,
  cacheWrite5m: string,
  cacheWrite1h: string,
  cacheRead: string,
  output: string,
): TokenPrices {
  return {
    input: perMillion(input),
    output: perMillion(output),
    cacheRead: perMillion(cacheRead),
    cacheWrite5m: perMillion(cacheWrite5m),
    cacheWrite1h: perMillion(cacheWrite1h),
  };
}

/**
 * The default table: every model in the source's "Model pricing" table whose API id the
 * documentation names. Columns in `row` follow the page: base input, 5m cache writes, 1h cache
 * writes, cache hits and refreshes, output.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  readOn: PRICES_READ_ON,
  sourceName: PRICES_SOURCE_NAME,
  models: [
    {
      ids: ["claude-fable-5-2"],
      label: "Claude Fable 5.2",
      prices: row("8", "10", "16", "0.20", "40"),
    },
    {
      ids: ["claude-mythos-5-2"],
      label: "Claude Mythos 5.2",
      prices: row("8", "10", "16", "0.20", "40"),
    },
    {
      ids: ["claude-fable-5-1"],
      label: "Claude Fable 5.1",
      prices: row("10", "12.50", "20", "0.25", "50"),
    },
    {
      ids: ["claude-mythos-5-1"],
      label: "Claude Mythos 5.1",
      prices: row("10", "12.50", "20", "0.25", "50"),
    },
    {
      ids: ["claude-fable-5"],
      label: "Claude Fable 5",
      prices: row("10", "12.50", "20", "1", "50"),
    },
    {
      ids: ["claude-mythos-5"],
      label: "Claude Mythos 5",
      prices: row("10", "12.50", "20", "1", "50"),
    },
    {
      ids: ["claude-opus-5-5"],
      label: "Claude Opus 5.5",
      prices: row("4", "5", "8", "0.20", "20"),
    },
    {
      ids: ["claude-opus-5"],
      label: "Claude Opus 5",
      prices: row("5", "6.25", "10", "0.50", "25"),
    },
    {
      ids: ["claude-opus-4-8"],
      label: "Claude Opus 4.8",
      prices: row("5", "6.25", "10", "0.50", "25"),
    },
    {
      ids: ["claude-opus-4-7"],
      label: "Claude Opus 4.7",
      prices: row("5", "6.25", "10", "0.50", "25"),
    },
    {
      ids: ["claude-opus-4-6"],
      label: "Claude Opus 4.6",
      prices: row("5", "6.25", "10", "0.50", "25"),
    },
    {
      ids: ["claude-opus-4-5", "claude-opus-4-5-20251101"],
      label: "Claude Opus 4.5",
      prices: row("5", "6.25", "10", "0.50", "25"),
    },
    {
      ids: ["claude-opus-4-1-20250805"],
      label: "Claude Opus 4.1",
      prices: row("15", "18.75", "30", "1.50", "75"),
    },
    {
      ids: ["claude-opus-4-20250514"],
      label: "Claude Opus 4",
      prices: row("15", "18.75", "30", "1.50", "75"),
    },
    {
      ids: ["claude-sonnet-5-5"],
      label: "Claude Sonnet 5.5",
      prices: row("2", "2.50", "4", "0.10", "10"),
    },
    {
      ids: ["claude-sonnet-5"],
      label: "Claude Sonnet 5",
      prices: row("2", "2.50", "4", "0.20", "10"),
    },
    {
      ids: ["claude-sonnet-4-6"],
      label: "Claude Sonnet 4.6",
      prices: row("3", "3.75", "6", "0.30", "15"),
    },
    {
      ids: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
      label: "Claude Sonnet 4.5",
      prices: row("3", "3.75", "6", "0.30", "15"),
    },
    {
      ids: ["claude-sonnet-4-20250514"],
      label: "Claude Sonnet 4",
      prices: row("3", "3.75", "6", "0.30", "15"),
    },
    {
      ids: ["claude-haiku-5-5"],
      label: "Claude Haiku 5.5",
      prices: row("0.10", "0.125", "0.20", "0.01", "0.50"),
      longPrompt: { overPromptTokens: 100_000, prices: row("0.50", "0.625", "1", "0.05", "2.50") },
    },
    {
      ids: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
      label: "Claude Haiku 4.5",
      prices: row("1", "1.25", "2", "0.10", "5"),
    },
  ],
};

const PRICE_KEYS: readonly (keyof TokenPrices)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkPrices(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("PriceTable: prices must be an object");
  for (const key of PRICE_KEYS) {
    const price = value[key];
    if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 0) {
      throw new TypeError(
        `PriceTable: ${key} must be a whole number of micro-dollars per million tokens, 0 or more`,
      );
    }
  }
}

/**
 * Check a price table a caller passes in, and return it typed. Throws a `TypeError` with fixed
 * text (a value is never quoted) when it has the wrong shape: a price that is not a whole,
 * non-negative number of micro-dollars per million tokens, a model with no id, or an id listed
 * twice.
 */
export function checkPriceTable(value: unknown): PriceTable {
  if (!isRecord(value)) throw new TypeError("PriceTable must be an object");
  if (typeof value["readOn"] !== "string")
    throw new TypeError("PriceTable: readOn must be a string");
  if (typeof value["sourceName"] !== "string") {
    throw new TypeError("PriceTable: sourceName must be a string");
  }
  const models = value["models"];
  if (!Array.isArray(models)) throw new TypeError("PriceTable: models must be an array");
  const seen = new Set<string>();
  for (const model of models as unknown[]) {
    if (!isRecord(model)) throw new TypeError("PriceTable: each model must be an object");
    if (typeof model["label"] !== "string") {
      throw new TypeError("PriceTable: each model needs a label");
    }
    const ids = model["ids"];
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new TypeError("PriceTable: each model needs at least one id");
    }
    for (const id of ids as unknown[]) {
      if (typeof id !== "string" || id === "") {
        throw new TypeError("PriceTable: a model id must be a non-empty string");
      }
      if (seen.has(id)) throw new TypeError("PriceTable: a model id is listed twice");
      seen.add(id);
    }
    checkPrices(model["prices"]);
    const long = model["longPrompt"];
    if (long !== undefined) {
      if (!isRecord(long)) throw new TypeError("PriceTable: longPrompt must be an object");
      const over = long["overPromptTokens"];
      if (typeof over !== "number" || !Number.isSafeInteger(over) || over < 0) {
        throw new TypeError("PriceTable: longPrompt.overPromptTokens must be a whole number");
      }
      checkPrices(long["prices"]);
    }
  }
  return value as unknown as PriceTable;
}

/** The entry for a model id, matched exactly, or `undefined` (unpriced). `null` is unpriced. */
export function findModelPrice(table: PriceTable, model: string | null): ModelPrice | undefined {
  if (model === null) return undefined;
  return table.models.find((entry) => entry.ids.includes(model));
}
