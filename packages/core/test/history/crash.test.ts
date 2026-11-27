// A writer process killed in the middle of a transaction (#25): the next run takes over its lock,
// loses nothing and stores nothing twice. Runs the built package in a child process, on temporary
// copies of the synthetic fixtures. Skipped, with the reason, without node:sqlite.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readHistoryLockOwner } from "../../src/history/lock.js";
import { claudeCodeAdapter, ingestHistory, openHistoryStore } from "../../src/sources/node.js";
import {
  copyAllFixtures,
  directLineCount,
  DIST_NODE_ENTRY,
  requireDist,
  sandboxSessions,
  spawnNode,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
  useSandbox,
  waitForExit,
  waitForOutput,
} from "./helpers.js";

const sandbox = useSandbox();

describe.skipIf(!SQLITE_AVAILABLE)(`history writer killed mid-transaction${SKIP_NOTE}`, () => {
  it("loses nothing and duplicates nothing on the next run", async () => {
    requireDist();
    const box = sandbox();
    await copyAllFixtures(box);
    const expected = await directLineCount(box.config);
    // The child blocks inside its third transaction, after writing to stdout synchronously.
    const script = `
        const { writeSync } = await import("node:fs");
        const core = await import(${JSON.stringify(pathToFileURL(DIST_NODE_ENTRY).href)});
        const root = JSON.parse(process.argv[1]);
        const store = await core.openHistoryStore({ mode: "write" });
        let commits = 0;
        await core.ingestHistory(store, { roots: [root] }, {
          batchLines: 40,
          testHooks: { beforeCommit() {
            commits += 1;
            if (commits === 3) {
              writeSync(1, "inside-transaction\\n");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
          } },
        });
        writeSync(1, "finished\\n");
      `;
    const child = spawnNode(script, [JSON.stringify(box.root)]);
    const exited = waitForExit(child);
    await waitForOutput(child, "inside-transaction");
    child.kill("SIGKILL");
    const { out } = await exited;
    expect(out).not.toContain("finished");

    // The dead writer's lock is still there.
    expect(readHistoryLockOwner(`${box.data}/history.lock`)?.pid).toBe(child.pid);

    const reader = await openHistoryStore({ mode: "read" });
    const committed = reader.totals().lines;
    reader.close();
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThan(expected);

    const store = await openHistoryStore({ mode: "write" });
    try {
      const result = await ingestHistory(store, { roots: [box.root] });
      expect(result.linesAdded).toBe(expected - committed);
      expect(store.totals().lines).toBe(expected);
      // Each stored session holds exactly the lines of its files, in order.
      for (const ref of await sandboxSessions(box)) {
        const input = await claudeCodeAdapter.openSession(ref);
        const fileLines: string[] = [];
        for await (const text of input.main as AsyncIterable<string>) {
          if (text.trim() !== "") fileLines.push(text);
        }
        const stored = store.readSession(ref.key)!;
        expect(stored.main.map((text) => JSON.parse(text) as unknown)).toEqual(
          fileLines.map((text) => JSON.parse(text) as unknown),
        );
      }
    } finally {
      store.close();
    }
    expect(existsSync(`${box.data}/history.lock`)).toBe(false);
  }, 30_000);
});
