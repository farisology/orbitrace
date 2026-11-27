# Ledger: tokens and cost estimate

The ledger (#26) shows where the tokens of one session went, and what they would cost at list
prices: for the whole session, per model and per agent. It is in `@orbitrace/core`
(`sessionLedger`, browser-safe) and in the app's inspector. Orbitrace is an independent project
and is not affiliated with Anthropic; the prices below are Anthropic's published list prices,
copied by hand.

## What is counted

Every reply of every agent in the replay, in four token classes, exactly as the transcript
recorded them in `message.usage`:

| Class          | Transcript field              | Replay field          |
| -------------- | ----------------------------- | --------------------- |
| Input          | `input_tokens`                | `inputTokens`         |
| Output         | `output_tokens`               | `outputTokens`        |
| Cache read     | `cache_read_input_tokens`     | `cacheReadTokens`     |
| Cache creation | `cache_creation_input_tokens` | `cacheCreationTokens` |

A reply written over several lines is counted once (the parser takes the maximum of each field
across its lines). The ledger's token totals are the sums of the replies, so they equal the
replay's own `totals` and the transcripts' usage. A test checks this for every committed fixture
session (`packages/core/test/ledger/reconcile.test.ts`), and checks that the model and agent
entries add up to the session.

**Per model.** A replay records one model per agent, the model most of its replies used, not a
model per reply. "Per model" groups agents by that model, and every reply of an agent is priced
at its agent's model. An agent that switched models part way is counted, and priced, entirely
under its main model. The inspector's note says so under every estimate.

**Per agent.** One entry per agent, in replay order: `main`, then `a1`, `a2`, ...

## Where the prices come from

From Anthropic's pricing page,
<https://platform.claude.com/docs/en/about-claude/pricing> ("Model pricing", "Prompt caching" and
"Long context pricing"), **read on 27 Nov 2026**. Model ids are the Claude API ids from
<https://platform.claude.com/docs/en/models/overview>, the model pages under
<https://platform.claude.com/docs/en/models/> and
<https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions>, read the same
day. The table is data in `packages/core/src/ledger/prices.ts` (`DEFAULT_PRICE_TABLE`), with the
same source and date in its header; a test checks that this page prints the same table.

US dollars per million tokens:

| Model                                          | Model ids                                         | Input | Output | Cache read | Cache write, 5 min | Cache write, 1 h |
| ---------------------------------------------- | ------------------------------------------------- | ----- | ------ | ---------- | ------------------ | ---------------- |
| Claude Fable 5.2                               | `claude-fable-5-2`                                | $8    | $40    | $0.20      | $10                | $16              |
| Claude Mythos 5.2                              | `claude-mythos-5-2`                               | $8    | $40    | $0.20      | $10                | $16              |
| Claude Fable 5.1                               | `claude-fable-5-1`                                | $10   | $50    | $0.25      | $12.50             | $20              |
| Claude Mythos 5.1                              | `claude-mythos-5-1`                               | $10   | $50    | $0.25      | $12.50             | $20              |
| Claude Fable 5                                 | `claude-fable-5`                                  | $10   | $50    | $1         | $12.50             | $20              |
| Claude Mythos 5                                | `claude-mythos-5`                                 | $10   | $50    | $1         | $12.50             | $20              |
| Claude Opus 5.5                                | `claude-opus-5-5`                                 | $4    | $20    | $0.20      | $5                 | $8               |
| Claude Opus 5                                  | `claude-opus-5`                                   | $5    | $25    | $0.50      | $6.25              | $10              |
| Claude Opus 4.8                                | `claude-opus-4-8`                                 | $5    | $25    | $0.50      | $6.25              | $10              |
| Claude Opus 4.7                                | `claude-opus-4-7`                                 | $5    | $25    | $0.50      | $6.25              | $10              |
| Claude Opus 4.6                                | `claude-opus-4-6`                                 | $5    | $25    | $0.50      | $6.25              | $10              |
| Claude Opus 4.5                                | `claude-opus-4-5`, `claude-opus-4-5-20251101`     | $5    | $25    | $0.50      | $6.25              | $10              |
| Claude Opus 4.1                                | `claude-opus-4-1-20250805`                        | $15   | $75    | $1.50      | $18.75             | $30              |
| Claude Opus 4                                  | `claude-opus-4-20250514`                          | $15   | $75    | $1.50      | $18.75             | $30              |
| Claude Sonnet 5.5                              | `claude-sonnet-5-5`                               | $2    | $10    | $0.10      | $2.50              | $4               |
| Claude Sonnet 5                                | `claude-sonnet-5`                                 | $2    | $10    | $0.20      | $2.50              | $4               |
| Claude Sonnet 4.6                              | `claude-sonnet-4-6`                               | $3    | $15    | $0.30      | $3.75              | $6               |
| Claude Sonnet 4.5                              | `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929` | $3    | $15    | $0.30      | $3.75              | $6               |
| Claude Sonnet 4                                | `claude-sonnet-4-20250514`                        | $3    | $15    | $0.30      | $3.75              | $6               |
| Claude Haiku 5.5 (prompt up to 100,000 tokens) | `claude-haiku-5-5`                                | $0.10 | $0.50  | $0.01      | $0.125             | $0.20            |
| Claude Haiku 5.5 (prompt over 100,000 tokens)  | `claude-haiku-5-5`                                | $0.50 | $2.50  | $0.05      | $0.625             | $1               |
| Claude Haiku 4.5                               | `claude-haiku-4-5`, `claude-haiku-4-5-20251001`   | $1    | $5     | $0.10      | $1.25              | $2               |

Older models the pricing page no longer lists, and models whose API id the documentation does
not name, are not in the table.

To update the table: read the pricing page again, change `prices.ts` and this page together,
and move the date in both (`PRICES_READ_ON`). Never write a price from memory.

### Matching a model

A model is priced only when its id, exactly as the transcript writes it in `message.model`, is
listed. There is no prefix, pattern or family match: a dated form is listed only where the
documentation names it. Anything else is **unpriced**:

- an id the table does not list (a newer model, another runtime's model, an undocumented dated
  form such as `claude-haiku-5-5-20260115` in the fixtures, an invented id such as
  `claude-quartz-1-0`);
- an agent whose model is `null` (the transcript had none, or Claude Code wrote a placeholder
  such as `<synthetic>`, which the replay builder drops).

An unpriced model's tokens are shown and counted in every token total. Its cost is never
guessed: it is left out of every cost total, and each total it belongs to is marked partial (the
inspector writes "(partial)" and names the unpriced models with their token counts).

**Opaque-name exports.** `orbitrace export --names opaque` keeps a known Claude model id and
writes `model: null` for any other, keeping the family when it is a known one (for example
`null` with family `opus`). Such an agent is **unpriced**. One family covers model generations
with different prices (Claude Opus 4.1 input is $15 per million tokens, Claude Opus 5.5 input is
$4), so the family alone does not say which price applies, and the ledger does not pick one.
Known ids survive an opaque export, so the fixture sessions price the same as-written and
opaque.

### Cache writes: 5-minute price by default

Cache writes have two prices, for the 5-minute and the 1-hour cache lifetime. The transcript
records only the total of cache creation tokens, not which lifetime was written, so the replay
cannot say either. **The ledger prices every cache creation token at the 5-minute price**, the
lifetime the prompt caching documentation names as the default. Where 1-hour caching was used,
the estimate for that class is low by the difference (the 1-hour price is 2x the input price,
the 5-minute price 1.25x). A caller can choose the 1-hour price with
`sessionLedger(model, { cacheWrite: "1h" })`; the inspector always uses the default and says so.

### Claude Haiku 5.5 long prompts

Claude Haiku 5.5 has higher prices for a request whose prompt is over 100,000 tokens, where the
prompt counts input, cache read and cache write tokens, and each request is priced on its own.
Each reply in a replay is one request with all three counts, so the ledger applies the right
set of prices to each reply.

## What an estimate means

Every cost is an estimate in **US dollars** (the pricing page's currency): the replay's tokens
multiplied by the list prices above. The inspector's cost columns read "Estimated cost (USD)" and
its note begins "Costs are estimates in US dollars". It is not a bill and may differ from what
you were charged:

- A subscription plan is not billed per token at all; the estimate then says what the same
  tokens would cost at API list prices.
- Prices change; the table is as of the date above.
- The estimate is computed from the replay, so a replay exported with `bucketTokens` (token
  counts rounded to 1, 2 or 5 times a power of ten) gives an estimate from the rounded counts.

**Arithmetic.** A price is kept as a whole number of micro-dollars per million tokens, so tokens
times price is an exact whole number of picodollars (10^-12 dollars). Costs are summed exactly
(as `bigint`) and rounded once, for display, half up to whole cents (`formatCostEstimate`). A
cost above zero that rounds to nothing reads "< $0.01".

**In the inspector.** A total that is partial shows the amount and "(partial)" as two parts that
each stay on one line; on a narrow panel, or with WCAG 1.4.12 text spacing, "(partial)" moves to
the line below and row headers may break inside a word, so the tables never grow wider than the
inspector (checked in Chrome at 1280 and 320 px wide with a partial session of over a billion
tokens; `ledger-panel.test.tsx` guards the rules in `ledger.css`).

## What is not included

- **Pricing modifiers the transcript does not record:** Batch API discounts, fast mode, data
  residency (`inference_geo`) multipliers, regional or multi-region endpoint premiums on cloud
  platforms, other cloud platforms' own prices, negotiated discounts.
- **Server tool fees** such as web search, charged per use on top of tokens.
- **A breakdown by tool.** A replay does not link a reply to the tool calls before or after it,
  and a reply's input tokens hold the whole conversation so far, so there is no honest rule
  that gives a tool call its share. The ledger leaves it out rather than invent one.
- **A breakdown by project, or across sessions.** The ledger covers the one session the app has
  open; totals across sessions and projects need the history store.
- **Model switches inside one agent** (see "Per model" above).

## Using it from code

```ts
import { formatCostEstimate, sessionLedger } from "@orbitrace/core";

const ledger = sessionLedger(replay); // default table, 5-minute cache writes
ledger.session.tokens; // { input, output, cacheRead, cacheCreation }
formatCostEstimate(ledger.session.cost.total); // "$1.23"
ledger.session.pricing; // "priced" | "partial" | "unpriced"
ledger.byModel; // one entry per model id (or per family when the id is null)
ledger.byAgent; // one entry per agent, in replay order
```

A caller can pass its own table: `sessionLedger(replay, { prices: myTable })`. It has the shape
of `PriceTable` (prices in whole micro-dollars per million tokens; `perMillion("0.125")` gives
`125000`) and is checked by `checkPriceTable`, which throws a `TypeError` with fixed text for a
wrong shape.
