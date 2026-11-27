// The single-writer lock of the history store (#25). The lock itself is plain files and runs on
// every Node; the tests that open a store skip, with the reason, without node:sqlite.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  acquireHistoryLock,
  historyLockSideFiles,
  newHistoryLockToken,
  readHistoryLockOwner,
} from "../../src/history/lock.js";
import { openHistoryStore } from "../../src/sources/node.js";
import {
  DIST_NODE_ENTRY,
  requireDist,
  spawnNode,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
  useSandbox,
  waitForExit,
  waitForOutput,
} from "./helpers.js";

const sandbox = useSandbox();

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = spawnNode("process.exit(0)");
  const pid = child.pid;
  await waitForExit(child);
  if (pid === undefined) throw new Error("no pid");
  return pid;
}

function lockFile(): string {
  return join(sandbox().data, "history.lock");
}

async function prepare(): Promise<string> {
  await mkdir(sandbox().data, { recursive: true });
  return lockFile();
}

describe("history lock", () => {
  it("lets one owner in and turns a second away with the holder's pid", async () => {
    const file = await prepare();
    const first = await acquireHistoryLock(file);
    expect(first.isHeld()).toBe(true);
    expect(readHistoryLockOwner(file)).toEqual(first.owner);
    await expect(acquireHistoryLock(file)).rejects.toMatchObject({
      code: "locked",
      message: expect.stringContaining(`process ${process.pid}`) as unknown as string,
    });
    first.release();
    first.release();
    expect(existsSync(file)).toBe(false);
    const second = await acquireHistoryLock(file);
    expect(second.owner.token).not.toBe(first.owner.token);
    second.release();
  });

  it("writes a token made beforehand, and refuses one that is not hex", async () => {
    const file = await prepare();
    const token = newHistoryLockToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(newHistoryLockToken()).not.toBe(token);
    const lock = await acquireHistoryLock(file, { token });
    expect(readHistoryLockOwner(file)?.token).toBe(token);
    lock.release();
    await expect(acquireHistoryLock(file, { token: "../escape" })).rejects.toMatchObject({
      code: "io",
    });
    expect(existsSync(file)).toBe(false);
  });

  it("names the side files of an owner after its token", () => {
    expect(historyLockSideFiles("/x/history.lock", "ab12")).toEqual({
      temp: "/x/history.lock.ab12.tmp",
      aside: "/x/history.lock.ab12.stale",
    });
  });

  it("waits for a holder that lets go within the wait", async () => {
    const file = await prepare();
    const first = await acquireHistoryLock(file);
    setTimeout(() => first.release(), 150);
    const second = await acquireHistoryLock(file, { waitMs: 5_000, pollMs: 20 });
    expect(second.isHeld()).toBe(true);
    second.release();
  });

  it("takes over a lock left by a process that is gone", async () => {
    const file = await prepare();
    const pid = await deadPid();
    writeFileSync(
      file,
      JSON.stringify({ pid, hostname: hostname(), token: "left", acquiredAt: 1 }),
    );
    const lock = await acquireHistoryLock(file);
    expect(readHistoryLockOwner(file)?.pid).toBe(process.pid);
    lock.release();
  });

  it("takes over a lock file that cannot be read as a lock", async () => {
    const file = await prepare();
    writeFileSync(file, "not json");
    const lock = await acquireHistoryLock(file);
    expect(lock.isHeld()).toBe(true);
    lock.release();
  });

  it("counts a lock from another computer as held", async () => {
    const file = await prepare();
    writeFileSync(
      file,
      JSON.stringify({ pid: 1, hostname: `${hostname()}-elsewhere`, token: "x", acquiredAt: 1 }),
    );
    await expect(acquireHistoryLock(file)).rejects.toMatchObject({
      code: "locked",
      message: expect.stringContaining("another computer") as unknown as string,
    });
  });

  it("does not delete a lock that another owner took after this one lost it", async () => {
    const file = await prepare();
    const first = await acquireHistoryLock(file);
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, hostname: hostname(), token: "other", acquiredAt: 2 }),
    );
    expect(first.isHeld()).toBe(false);
    first.release();
    expect(readHistoryLockOwner(file)?.token).toBe("other");
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`history store writers${SKIP_NOTE}`, () => {
  it("allows one writer per store and any number of readers", async () => {
    const store = await openHistoryStore({ mode: "write" });
    try {
      await expect(openHistoryStore({ mode: "write" })).rejects.toMatchObject({ code: "locked" });
      const readers = [
        await openHistoryStore({ mode: "read" }),
        await openHistoryStore({ mode: "read" }),
      ];
      for (const reader of readers) {
        expect(reader.totals()).toEqual({ sessions: 0, files: 0, lines: 0 });
        reader.close();
      }
    } finally {
      store.close();
    }
    const again = await openHistoryStore({ mode: "write" });
    again.close();
  });

  it("takes over the lock of a writer process that died", async () => {
    await prepare();
    const pid = await deadPid();
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid, hostname: hostname(), token: "left", acquiredAt: 1 }),
    );
    const store = await openHistoryStore({ mode: "write" });
    expect(readHistoryLockOwner(lockFile())?.pid).toBe(process.pid);
    store.close();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("makes a second writer process fail at once, or wait until the first one finishes", async () => {
    requireDist();
    const script = `
        const core = await import(${JSON.stringify(pathToFileURL(DIST_NODE_ENTRY).href)});
        const store = await core.openHistoryStore({ mode: "write" });
        console.log("holding");
        setTimeout(() => { store.close(); console.log("released"); }, 600);
      `;
    const child = spawnNode(script);
    const exited = waitForExit(child);
    await waitForOutput(child, "holding");
    const holder = JSON.parse(readFileSync(lockFile(), "utf8")) as { pid: number };
    expect(holder.pid).toBe(child.pid);
    await expect(openHistoryStore({ mode: "write" })).rejects.toMatchObject({ code: "locked" });
    const store = await openHistoryStore({ mode: "write", lockWaitMs: 15_000 });
    expect(readHistoryLockOwner(lockFile())?.pid).toBe(process.pid);
    store.close();
    const { code, out } = await exited;
    expect(code).toBe(0);
    expect(out).toContain("released");
  }, 30_000);
});
