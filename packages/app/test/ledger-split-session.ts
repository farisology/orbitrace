// Issue 203: the synthetic cache-write-split session as a host serves it, and the checks that the
// inspector shows its cache-write split. The session comes from the seeded generator in
// @orbitrace/fixtures (`generateExtraSession`), so every value is invented; it is written to a
// temporary folder and read back by core's own session replayer, as the CLI and the editor do.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { within } from "@testing-library/react";
import { expect } from "vitest";
import type { ReplayModel, SessionSummary, SourceRoot } from "@orbitrace/core";
import { createNodeSessionReplayer } from "@orbitrace/core/node";
import { generateExtraSession, type GeneratedExtraSession } from "@orbitrace/fixtures/generator";
import { formatCount } from "../src/format";

/** The split scenario: the main agent and two subagents record it, `docs-scribe` does not. */
export const SPLIT_SCENARIO = "cache-write-split";

/** Labels of the split rows (`cacheWriteRows` in src/ledger.ts). */
export const SPLIT_ROW_LABELS = {
  recorded5m: "Cache creation, 5-minute cache",
  recorded1h: "Cache creation, 1-hour cache",
  unrecorded: "Cache creation, cache not recorded",
} as const;

/** The start of the note shown when no cache write records its lifetime. */
export const FALLBACK_NOTE = /^Cache writes are priced at the 5-minute cache price/;

/** Token counts the inspector should show, from the generator's own facts (not from core). */
export interface SplitTokens {
  readonly recorded5m: number;
  readonly recorded1h: number;
  readonly unrecorded: number;
}

/** The split-row token counts the generator says the session holds. */
export function expectedSplit(session: GeneratedExtraSession): SplitTokens {
  const recorded = session.expected.totals.cacheCreation;
  if (recorded === undefined) throw new Error("the split scenario records no split");
  const unrecorded = session.expected.agents
    .filter((agent) => agent.cacheCreation === undefined)
    .reduce((sum, agent) => sum + agent.usage.cache_creation_input_tokens, 0);
  return {
    recorded5m: recorded.ephemeral_5m_input_tokens,
    recorded1h: recorded.ephemeral_1h_input_tokens,
    unrecorded,
  };
}

/** The split session served by core's session replayer from a temporary config folder. */
export interface SplitHost {
  readonly session: GeneratedExtraSession;
  readonly summary: SessionSummary;
  /** What `load` gives, the model `loadReplay` answers with. */
  readonly loaded: ReplayModel;
  /** The first update of `follow`, the model a live subscription starts with. */
  readonly followed: ReplayModel;
  readonly expected: SplitTokens;
  /** Delete the temporary folder. */
  remove(): void;
}

/**
 * Write each file of a generated session below `dir`, as `writeGeneratedSession` does. That
 * function is on the fixtures package's main entry, which works out the repository's fixtures
 * folder from its own module URL when it is imported, and that fails in the page environment
 * these tests run in; the `./generator` entry has no such step.
 */
function writeSession(dir: string, session: GeneratedExtraSession): void {
  for (const file of session.files) {
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
}

/** Write the split session to a temporary config folder and serve it with core's replayer. */
export async function splitHost(): Promise<SplitHost> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-ledger-split-")));
  const session = generateExtraSession(SPLIT_SCENARIO);
  writeSession(dir, session);
  const root: SourceRoot = {
    runtime: "claude-code",
    root: dir,
    resolvedBy: "user-setting",
    available: true,
  };
  const replayer = createNodeSessionReplayer({ roots: [root] });
  const [summary] = await replayer.list();
  if (summary === undefined) throw new Error("the split session was not found");
  const loaded = await replayer.load(summary.key);
  const followed = await new Promise<ReplayModel>((resolve, reject) => {
    const stop = replayer.follow(summary.key, (update) => {
      queueMicrotask(() => stop());
      if (update.type === "replay") resolve(update.replay);
      else reject(new Error(`expected a replay update, got ${update.type}`));
    });
  });
  return {
    session,
    summary,
    loaded,
    followed,
    expected: expectedSplit(session),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

/**
 * The inspector's session token table shows the cache creation class as the three split rows
 * with the expected tokens, and no fallback note.
 */
export function expectSplitRows(container: HTMLElement, expected: SplitTokens): void {
  const table = within(container).getByRole("table", { name: "Session tokens" });
  const headers = within(table)
    .getAllByRole("rowheader")
    .map((header) => header.textContent);
  expect(headers).toEqual([
    "Input",
    "Output",
    "Cache read",
    SPLIT_ROW_LABELS.recorded5m,
    SPLIT_ROW_LABELS.recorded1h,
    SPLIT_ROW_LABELS.unrecorded,
    "Total",
  ]);
  for (const key of ["recorded5m", "recorded1h", "unrecorded"] as const) {
    const row = within(table).getByRole("row", { name: new RegExp(`^${SPLIT_ROW_LABELS[key]}`) });
    expect([key, cells(row)[0]]).toEqual([key, formatCount(expected[key])]);
  }
  expect(within(container).queryByText(FALLBACK_NOTE)).toBeNull();
}

/** The inspector shows one cache creation row and the fallback note: no split arrived. */
export function expectFallback(container: HTMLElement): void {
  const table = within(container).getByRole("table", { name: "Session tokens" });
  expect(within(table).getByRole("row", { name: /^Cache creation/ })).toBeDefined();
  expect(within(table).queryByRole("row", { name: /5-minute cache/ })).toBeNull();
  expect(within(container).getByText(FALLBACK_NOTE)).toBeDefined();
}
