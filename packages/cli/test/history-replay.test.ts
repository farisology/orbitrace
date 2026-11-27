/**
 * #195: sessions that exist only in the history store are listed (marked as history), exported
 * and opened through the same replayer, parser, replay builder and export allow-list as sessions
 * read from files. Synthetic fixture sessions in temporary folders. Skipped, with the reason, on a
 * Node without node:sqlite.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  listSessions,
  toSessionSummary,
  validateReplay,
  type SessionRef,
  type SessionSummary,
} from "@orbitrace/core";
import { claudeCodeAdapter } from "@orbitrace/core/node";
import type { CliRuntime } from "../src/cli.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import { historyAwareAdapter, historyRoot, isHistoryRef } from "../src/history/source.js";
import { formatSessionTable } from "../src/output.js";
import type { LoopbackServer } from "../src/server/server.js";
import { removeTempDirs } from "./helpers.js";
import {
  historyRuntime,
  makeHistoryMachine,
  oneJson,
  runCli,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
  type HistoryMachine,
} from "./history-helpers.js";
import { makeAppFolder, rpc } from "./server-helpers.js";

afterAll(() => {
  removeTempDirs();
});

/** The fixture sessions of a machine, from files. */
async function fileSessions(machine: HistoryMachine): Promise<readonly SessionRef[]> {
  return listSessions(
    [
      {
        runtime: "claude-code",
        root: machine.configDir,
        resolvedBy: "user-setting",
        available: true,
      },
    ],
    [claudeCodeAdapter],
  );
}

/** Export every session with `extra` flags, to files named after the key, and return the bytes. */
async function exportAll(
  machine: HistoryMachine,
  keys: readonly string[],
  folder: string,
  extra: readonly string[] = [],
): Promise<Map<string, Buffer>> {
  const bytes = new Map<string, Buffer>();
  for (const key of keys) {
    const file = join(machine.root, `${folder}-${key.replace(":", "-")}.json`);
    const result = await runCli(["export", key, "-o", file, ...extra], machine.host);
    expect(result).toMatchObject({ code: 0 });
    bytes.set(key, readFileSync(file));
  }
  return bytes;
}

describe.skipIf(!SQLITE_AVAILABLE)(`sessions only in history${SKIP_NOTE}`, () => {
  it("export the same bytes from history as from their files before they were deleted", async () => {
    const machine = makeHistoryMachine();
    const keys = (await fileSessions(machine)).map((ref) => ref.key);
    expect(keys).toHaveLength(9);
    const fromFiles = await exportAll(machine, keys, "files");
    const pretty = await exportAll(machine, keys, "files-opaque", ["--opaque-names", "--pretty"]);
    expect((await runCli(["history", "ingest"], machine.host)).code).toBe(0);
    // Claude Code's cleanup: every transcript and subagent file is gone.
    rmSync(machine.configDir, { recursive: true, force: true });
    const fromHistory = await exportAll(machine, keys, "history");
    const prettyHistory = await exportAll(machine, keys, "history-opaque", [
      "--opaque-names",
      "--pretty",
    ]);
    // The synthetic fixtures hold no secrets, so redaction changed nothing.
    const different = keys.filter(
      (key) =>
        fromHistory.get(key)?.equals(fromFiles.get(key)!) !== true ||
        prettyHistory.get(key)?.equals(pretty.get(key)!) !== true,
    );
    expect(different).toEqual([]);
    for (const key of keys) {
      expect(validateReplay(JSON.parse(fromHistory.get(key)!.toString("utf8")))).toBe(true);
    }
  }, 60_000);

  it("are listed and marked as history, and --latest and key starts find them", async () => {
    const machine = makeHistoryMachine();
    const refs = await fileSessions(machine);
    expect((await runCli(["history", "ingest"], machine.host)).code).toBe(0);
    // Unchanged while the files are there: no history mark, the same summaries as before.
    const before = oneJson((await runCli(["list", "--json"], machine.host)).stdout) as {
      sessions: SessionSummary[];
    };
    expect(before.sessions).toEqual(refs.map(toSessionSummary));
    const beforeText = await runCli(["list"], machine.host);
    expect(beforeText.stdout.split("\n")[0]).toMatch(
      /^KEY\s+LAST ACTIVITY\s+LIVE\s+SUBAGENTS\s+PROJECT$/,
    );

    rmSync(machine.configDir, { recursive: true, force: true });
    const after = oneJson((await runCli(["list", "--json"], machine.host)).stdout) as {
      sessions: (SessionSummary & { history?: boolean })[];
      warnings: unknown[];
    };
    expect(after.warnings).toEqual([]);
    expect(after.sessions).toHaveLength(9);
    for (const session of after.sessions) {
      expect(session.history).toBe(true);
      expect(session.live).toBe("ended");
      expect(Object.keys(session)).toEqual([
        "key",
        "runtime",
        "projectLabel",
        "sessionId",
        "lastActivity",
        "live",
        "subagentCount",
        "history",
      ]);
    }
    expect(new Set(after.sessions.map((session) => session.key))).toEqual(
      new Set(refs.map((ref) => ref.key)),
    );
    const text = await runCli(["list"], machine.host);
    const lines = text.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^KEY\s+LAST ACTIVITY\s+LIVE\s+SUBAGENTS\s+SOURCE\s+PROJECT$/);
    expect(lines.slice(1).every((line) => /\shistory\s/.test(line))).toBe(true);

    const latest = await runCli(["export", "--latest", "--json"], machine.host);
    expect(latest.code).toBe(0);
    const doc = oneJson(latest.stdout) as { key: string };
    expect(doc.key).toBe(after.sessions[0]?.key);
    const start = doc.key.slice("claude-code:".length, "claude-code:".length + 10);
    expect((await runCli(["export", start, "--json"], machine.host)).code).toBe(0);
  }, 60_000);

  it("prefers a session's files while they are there", async () => {
    const machine = makeHistoryMachine();
    const refs = await fileSessions(machine);
    expect((await runCli(["history", "ingest"], machine.host)).code).toBe(0);
    const dbFile = join(machine.data, "history.sqlite");
    const root = historyRoot(dbFile);
    const adapter = historyAwareAdapter(claudeCodeAdapter, dbFile, { env: machine.host.env });
    const merged = await listSessions(
      [
        {
          runtime: "claude-code",
          root: machine.configDir,
          resolvedBy: "environment",
          available: true,
        },
        root,
      ],
      [adapter],
    );
    expect(merged).toHaveLength(refs.length);
    expect(merged.some(isHistoryRef)).toBe(false);
    const onlyHistory = await adapter.listSessions(root);
    expect(onlyHistory).toHaveLength(refs.length);
    expect(onlyHistory.every(isHistoryRef)).toBe(true);
    expect(onlyHistory.every((ref) => ref.locator.startsWith("orbitrace-history:"))).toBe(true);
    // A stored session never changes: watching it does nothing and stopping is safe.
    const stop = adapter.watchSession?.(onlyHistory[0]!, () => {
      throw new Error("a stored session must not report changes");
    });
    stop?.();
    // A ref from files is still read from files.
    const fromFiles = await adapter.openSession(refs[0]!);
    expect(fromFiles.main).not.toBeInstanceOf(Array);
    const fromStore = await adapter.openSession(onlyHistory[0]!);
    expect(Array.isArray(fromStore.main)).toBe(true);
    await expect(
      adapter.openSession({
        ...onlyHistory[0]!,
        key: "claude-code:not-stored",
        locator: "orbitrace-history:x",
      }),
    ).rejects.toThrow();
  }, 30_000);

  it("open lists and serves them to the app", async () => {
    const machine = makeHistoryMachine();
    const refs = await fileSessions(machine);
    expect((await runCli(["history", "ingest"], machine.host)).code).toBe(0);
    rmSync(machine.configDir, { recursive: true, force: true });
    const app = makeAppFolder();
    const controller = new AbortController();
    let listed: unknown;
    let loaded: unknown;
    let during: Promise<void> = Promise.resolve();
    const runtime: CliRuntime = {
      history: historyRuntime(),
      appDir: app.appDir,
      stopSignal: controller.signal,
      onListening: (server: LoopbackServer) => {
        during = (async () => {
          listed = JSON.parse(
            (await rpc(server.port, server.token, { id: 1, method: "listSessions", params: {} }))
              .body,
          );
          loaded = JSON.parse(
            (
              await rpc(server.port, server.token, {
                id: 2,
                method: "loadReplay",
                params: { key: refs[0]!.key },
              })
            ).body,
          );
        })().finally(() => controller.abort());
      },
    };
    const result = await runCli(["open", "--no-browser", "--json"], machine.host, runtime);
    await during;
    expect(result.code).toBe(0);
    const doc = oneJson(result.stdout) as { key: string; warnings: unknown[] };
    expect(doc.warnings).toEqual([]);
    expect(refs.map((ref) => ref.key)).toContain(doc.key);
    expect(listed).toMatchObject({ kind: "result", id: 1 });
    const sessions = (listed as { result: { key: string }[] }).result;
    expect(sessions.map((session) => session.key).sort()).toEqual(
      refs.map((ref) => ref.key).sort(),
    );
    expect(loaded).toMatchObject({ kind: "result", id: 2 });
    expect(validateReplay((loaded as { result: unknown }).result)).toBe(true);
  }, 60_000);
});

describe("a store this Node cannot read", () => {
  it.skipIf(!SQLITE_AVAILABLE)(
    "is left out of list with a warning, and the rest works",
    async () => {
      const machine = makeHistoryMachine();
      expect((await runCli(["history", "ingest"], machine.host)).code).toBe(0);
      const runtime: CliRuntime = {
        history: historyRuntime({
          capability: () =>
            Promise.resolve({
              available: false,
              engine: "node:sqlite",
              nodeVersion: "v20.19.0",
              reason: "This Node.js (v20.19.0) has no node:sqlite module.",
            }),
        }),
      };
      const result = await runCli(["list", "--json"], machine.host, runtime);
      expect(result.code).toBe(0);
      const doc = oneJson(result.stdout) as { sessions: unknown[]; warnings: unknown[] };
      expect(doc.sessions).toHaveLength(9);
      expect(doc.warnings).toEqual([
        {
          code: "history-unavailable",
          message:
            "Sessions in the history store are not listed: This Node.js (v20.19.0) has no node:sqlite module.",
        },
      ]);
      rmSync(machine.configDir, { recursive: true, force: true });
      const none = await runCli(["export", "--latest"], machine.host, runtime);
      expect(none.code).toBe(CLI_EXIT_CODES["no-sessions"]);
      expect(none.stderr).toContain("Sessions in the history store are not listed");
    },
    30_000,
  );
});

describe("the session table", () => {
  const session = (key: string, history?: true): SessionSummary & { history?: true } => ({
    key,
    runtime: "claude-code",
    projectLabel: "example-project",
    sessionId: "00000000-0000-4000-8000-000000000001",
    lastActivity: Number.NaN,
    live: "ended",
    subagentCount: 1,
    ...(history === undefined ? {} : { history }),
  });

  it("adds a SOURCE column only when a session comes from history", () => {
    const plain = formatSessionTable([session("claude-code:aaaa")]);
    expect(plain.split("\n")[0]).toMatch(/^KEY\s+LAST ACTIVITY\s+LIVE\s+SUBAGENTS\s+PROJECT$/);
    const mixed = formatSessionTable([
      session("claude-code:aaaa"),
      session("claude-code:bbbb", true),
    ]);
    const lines = mixed.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^KEY\s+LAST ACTIVITY\s+LIVE\s+SUBAGENTS\s+SOURCE\s+PROJECT$/);
    expect(lines[1]).toMatch(/\sfiles\s+example-project$/);
    expect(lines[2]).toMatch(/\shistory\s+example-project$/);
  });
});
