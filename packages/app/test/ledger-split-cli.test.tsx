// @vitest-environment node
/**
 * End to end (issue 203): the cache-write split travels from the real loopback server of the
 * built `orbitrace` command to the app's inspector, and exporting still writes exactly what
 * `orbitrace export` writes.
 *
 * The synthetic cache-write-split session (`generateExtraSession` in @orbitrace/fixtures) is
 * written into the sandbox's config tree next to the committed fixture sessions. The app reads it
 * with its HTTP transport, once (`loadReplay`) and live (`subscribe`), and the inspector is
 * rendered from what arrived. Runs in the Node environment, so `fetch` is Node's (as in
 * `e2e-http/`); the inspector is rendered to markup with React's server renderer and read with
 * happy-dom.
 *
 * Privacy: every child process gets the sandbox's environment (see `e2e-http/cli-server.ts`):
 * `HOME` and `CLAUDE_CONFIG_DIR` name a temporary folder with a synthetic config tree, set before
 * the process starts, so the real home and config folders are never read. Skipped on Windows,
 * like the other end-to-end tests of this transport.
 */
import { spawnSync } from "node:child_process";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  validateReplay,
  validateReplayModel,
  withoutReplyDetails,
  type ReplayModel,
  type SessionSummary,
} from "@orbitrace/core";
import { generateExtraSession, writeGeneratedSession } from "@orbitrace/fixtures";
import { createClock } from "../src/clock";
import { Inspector } from "../src/components/Inspector";
import { DEFAULT_EXPORT_CHOICES, makeReplayFile } from "../src/export-replay";
import { createHttpTransport, type FetchFunction } from "../src/http-transport";
import { replayFromJson } from "../src/load-file";
import type { HostTransport, LiveUpdate } from "../src/transport";
import { ClockContext } from "../src/use-clock";
import {
  CLI_BIN,
  createSandbox,
  eventually,
  killIfRunning,
  removeSandbox,
  sandboxEnv,
  startCli,
  type RunningCli,
  type Sandbox,
} from "./e2e-http/cli-server";
import {
  FALLBACK_NOTE,
  SPLIT_ROW_LABELS,
  SPLIT_SCENARIO,
  expectedSplit,
  type SplitTokens,
} from "./ledger-split-session";
import { formatCount } from "../src/format";

/** Node's `fetch` against the server's origin (the transport sends origin-relative paths). */
function fetchAt(origin: string): FetchFunction {
  return (path, init) => fetch(new URL(path, origin), init);
}

/** What `orbitrace export <key> [flags]` writes to stdout, in the sandbox. */
function cliExport(sandbox: Sandbox, key: string, flags: readonly string[] = []): string {
  const result = spawnSync(process.execPath, [CLI_BIN, "export", key, ...flags], {
    cwd: sandbox.home,
    env: sandboxEnv(sandbox),
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0) {
    throw new Error(`orbitrace export exited with ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout;
}

/** The session part of the inspector for `model`, as markup read back into a document. */
function inspectorDocument(model: ReplayModel): Document {
  const html = renderToStaticMarkup(
    <ClockContext.Provider value={createClock({ time: 0, duration: model.totals.duration })}>
      <Inspector model={model} selected={null} onSelect={() => {}} />
    </ClockContext.Provider>,
  );
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

/** Row header and first cell of each row of the "Session tokens" table. */
function sessionTokenRows(doc: Document): [string, string][] {
  const table = [...doc.querySelectorAll("table")].find(
    (candidate) => candidate.querySelector("caption")?.textContent === "Session tokens",
  );
  if (table === undefined) throw new Error("no Session tokens table");
  return [...table.querySelectorAll("tr")]
    .filter((row) => row.querySelector('th[scope="row"]') !== null)
    .map((row) => [
      row.querySelector('th[scope="row"]')?.textContent ?? "",
      row.querySelector("td")?.textContent ?? "",
    ]);
}

function expectSplitInInspector(model: ReplayModel, expected: SplitTokens): void {
  const doc = inspectorDocument(model);
  const rows = sessionTokenRows(doc);
  expect(rows.map(([label]) => label)).toEqual([
    "Input",
    "Output",
    "Cache read",
    SPLIT_ROW_LABELS.recorded5m,
    SPLIT_ROW_LABELS.recorded1h,
    SPLIT_ROW_LABELS.unrecorded,
    "Total",
  ]);
  const tokens = new Map(rows);
  for (const key of ["recorded5m", "recorded1h", "unrecorded"] as const) {
    expect([key, tokens.get(SPLIT_ROW_LABELS[key])]).toEqual([key, formatCount(expected[key])]);
  }
  const notes = [...doc.querySelectorAll("p")].map((p) => p.textContent ?? "");
  expect(notes.some((note) => FALLBACK_NOTE.test(note))).toBe(false);
}

const ALL_CHOICES = { opaqueNames: true, roundTimes: true, roundStep: 0.1, bucketTokens: true };
const ALL_FLAGS = ["--opaque-names", "--round-times", "0.1", "--bucket-tokens"];

describe.skipIf(process.platform === "win32")(
  "the cache-write split through the CLI loopback server (issue 203)",
  { timeout: 120_000 },
  () => {
    const session = generateExtraSession(SPLIT_SCENARIO);
    const expected = expectedSplit(session);
    let sandbox: Sandbox;
    let cli: RunningCli | undefined;
    let transport: HostTransport;
    let key: string;

    beforeAll(async () => {
      sandbox = createSandbox();
      writeGeneratedSession(sandbox.configDir, session);
      cli = await startCli(sandbox);
      const token = new URLSearchParams(new URL(cli.document.url).hash.slice(1)).get("t");
      if (token === null) throw new Error("the link has no token");
      transport = createHttpTransport({ token, fetch: fetchAt(cli.document.origin) });
      const listed = await transport.listSessions();
      const summary = listed.find((entry: SessionSummary) => entry.sessionId === session.sessionId);
      if (summary === undefined) throw new Error("the split session is not listed");
      key = summary.key;
    });

    afterAll(async () => {
      await killIfRunning(cli);
      removeSandbox(sandbox);
    });

    it("loadReplay brings the split, and the inspector shows the split rows", async () => {
      const model = await transport.loadReplay(key);
      expect(validateReplayModel(model)).toBe(true);
      expect(validateReplay(model)).toBe(false);
      expect(validateReplay(withoutReplyDetails(model))).toBe(true);
      expectSplitInInspector(model, expected);
    });

    it("a live subscription brings the split in its first update", async () => {
      const updates: LiveUpdate[] = [];
      const stop = transport.subscribe(key, (update) => updates.push(update));
      try {
        await eventually(() => updates.length >= 1);
      } finally {
        stop();
      }
      const first = updates[0];
      expect(first?.type).toBe("replay");
      if (first?.type !== "replay") return;
      expect(validateReplayModel(first.replay)).toBe(true);
      expectSplitInInspector(first.replay, expected);
    });

    it("the app's Export writes what orbitrace export writes, with and without options", async () => {
      const model = await transport.loadReplay(key);
      const plain = makeReplayFile(model, DEFAULT_EXPORT_CHOICES);
      expect(plain.data).toBe(cliExport(sandbox, key));
      expect(plain.data).not.toContain("cacheWrite");
      expect(makeReplayFile(model, ALL_CHOICES).data).toBe(cliExport(sandbox, key, ALL_FLAGS));
    });

    it("the exported file, opened in the app, has no split and shows the fallback note", async () => {
      const opened = replayFromJson(cliExport(sandbox, key));
      if (!opened.ok) throw new Error("the export did not open as a replay file");
      const doc = inspectorDocument(opened.model);
      expect(sessionTokenRows(doc).map(([label]) => label)).toContain("Cache creation");
      const notes = [...doc.querySelectorAll("p")].map((p) => p.textContent ?? "");
      expect(notes.some((note) => FALLBACK_NOTE.test(note))).toBe(true);
    });
  },
);
