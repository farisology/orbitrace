// Sessions kept only in the history store (#211, from the CLI's #195): the history root and the
// history-aware adapter both hosts use. Synthetic fixture sessions copied into temporary folders;
// the store parts are skipped, with the reason in the suite name, on a Node without node:sqlite.
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  validateReplay,
  validateReplayModel,
  withoutReplyDetails,
  type SessionRef,
  type SourceAdapter,
} from "../../src/index.js";
import {
  claudeCodeAdapter,
  createSessionReplayer,
  HISTORY_LOCATOR_PREFIX,
  historyAwareAdapter,
  historyRoot,
  ingestHistory,
  isHistoryRef,
  openHistoryStore,
  resolveHistoryLocation,
} from "../../src/sources/node.js";
import { copyFixtureSession, SKIP_NOTE, SQLITE_AVAILABLE, useSandbox } from "./helpers.js";

const sandbox = useSandbox();

describe("historyRoot and isHistoryRef", () => {
  it("make a Claude Code root searched after the config folders, and tell stored refs apart", () => {
    expect(historyRoot("/srv/example-data/history.sqlite")).toEqual({
      runtime: "claude-code",
      root: "/srv/example-data/history.sqlite",
      resolvedBy: "extra-root",
      available: true,
    });
    expect(isHistoryRef({ locator: `${HISTORY_LOCATOR_PREFIX}claude-code:example` })).toBe(true);
    expect(isHistoryRef({ locator: "/srv/example-config/projects/x/example.jsonl" })).toBe(false);
  });
});

describe("historyAwareAdapter without a store", () => {
  it("passes file roots, refs and watches to the Claude Code adapter", async () => {
    const watched: string[] = [];
    const base: SourceAdapter = {
      ...claudeCodeAdapter,
      resolveRoots: vi.fn(async () => []),
      listSessions: vi.fn(async () => []),
      openSession: vi.fn(async () => ({ main: { lines: [] }, subagents: [] }) as never),
      watchSession: (ref) => {
        watched.push(ref.key);
        return () => undefined;
      },
    };
    const adapter = historyAwareAdapter(base, "/srv/example-data/history.sqlite", {});
    const fileRoot = sandbox().root;
    await adapter.resolveRoots({ platform: "linux", homeDir: "/srv/home", env: {} });
    await adapter.listSessions(fileRoot);
    expect(base.resolveRoots).toHaveBeenCalledTimes(1);
    expect(base.listSessions).toHaveBeenCalledWith(fileRoot, undefined);
    const fileRef = { key: "claude-code:file", locator: "/srv/x.jsonl" } as SessionRef;
    await adapter.openSession(fileRef);
    expect(base.openSession).toHaveBeenCalledWith(fileRef);
    adapter.watchSession?.(fileRef, () => undefined);
    const stop = adapter.watchSession?.(
      {
        key: "claude-code:stored",
        locator: `${HISTORY_LOCATOR_PREFIX}claude-code:stored`,
      } as SessionRef,
      () => undefined,
    );
    expect(watched).toEqual(["claude-code:file"]);
    expect(() => stop?.()).not.toThrow();
  });

  it("has no watch when the base adapter has none", () => {
    const base: SourceAdapter = {
      runtime: claudeCodeAdapter.runtime,
      displayName: claudeCodeAdapter.displayName,
      resolveRoots: (context) => claudeCodeAdapter.resolveRoots(context),
      listSessions: (root, options) => claudeCodeAdapter.listSessions(root, options),
      openSession: (ref) => claudeCodeAdapter.openSession(ref),
    };
    expect(historyAwareAdapter(base, "/srv/example.sqlite", {}).watchSession).toBeUndefined();
  });
});

describe(`a session whose transcript is gone, read from history${SKIP_NOTE}`, () => {
  it.skipIf(!SQLITE_AVAILABLE)(
    "is listed under the history root as ended and replays through the same replayer",
    async () => {
      const box = sandbox();
      const transcript = await copyFixtureSession(box, "two-waves");
      await copyFixtureSession(box, "tool-failures");
      const writer = await openHistoryStore({ mode: "write" });
      try {
        await ingestHistory(writer, { roots: [box.root] });
      } finally {
        writer.close();
      }
      const location = resolveHistoryLocation();
      const adapter = historyAwareAdapter(claudeCodeAdapter, location.dbFile, {});
      const replayer = createSessionReplayer({
        adapters: [adapter],
        roots: async () => [box.root, historyRoot(location.dbFile)],
      });
      const before = await replayer.list();
      expect(before).toHaveLength(2);
      // Both are found in their files first.
      for (const summary of before)
        expect(isHistoryRef(await replayer.find(summary.key))).toBe(false);

      // Claude Code's cleanup: the transcript and its subagents folder are gone.
      const gone = (
        await Promise.all(before.map(async (s) => ({ s, ref: await replayer.find(s.key) })))
      ).find((entry) => entry.ref.locator === transcript);
      expect(gone).toBeDefined();
      const fromFiles = await replayer.load(gone?.s.key ?? "");
      await rm(transcript);
      await rm(join(dirname(transcript), gone?.s.sessionId ?? "none"), {
        recursive: true,
        force: true,
      });

      const after = await replayer.list();
      expect(after.map((s) => s.key).sort()).toEqual(before.map((s) => s.key).sort());
      const stored = await replayer.find(gone?.s.key ?? "");
      expect(isHistoryRef(stored)).toBe(true);
      expect(stored.live).toBe("ended");
      expect(stored.locator).toBe(`${HISTORY_LOCATOR_PREFIX}${gone?.s.key}`);
      const replay = await replayer.load(gone?.s.key ?? "");
      // The replayer hands out an in-memory model with reply details (#203); without them it is
      // plain replay v1.
      expect(validateReplayModel(replay)).toBe(true);
      expect(validateReplay(withoutReplyDetails(replay))).toBe(true);
      // The same replay as from its files.
      expect(replay).toEqual(fromFiles);

      // A later `since` leaves it out; its own time keeps it.
      const keysSince = async (since: number): Promise<string[]> =>
        (await adapter.listSessions(historyRoot(location.dbFile), { since })).map((r) => r.key);
      expect(await keysSince(stored.lastActivity + 1)).not.toContain(stored.key);
      expect(await keysSince(stored.lastActivity)).toContain(stored.key);
    },
  );

  it.skipIf(!SQLITE_AVAILABLE)("fails to open a stored ref that was deleted", async () => {
    const box = sandbox();
    await copyFixtureSession(box, "single-agent");
    const writer = await openHistoryStore({ mode: "write" });
    let key: string;
    try {
      await ingestHistory(writer, { roots: [box.root] });
      key = writer.listSessions()[0]?.key ?? "";
      writer.deleteSession(key);
    } finally {
      writer.close();
    }
    const adapter = historyAwareAdapter(claudeCodeAdapter, resolveHistoryLocation().dbFile, {});
    await expect(
      adapter.openSession({ key, locator: `${HISTORY_LOCATOR_PREFIX}${key}` } as SessionRef),
    ).rejects.toThrow("no longer in the history store");
  });
});
