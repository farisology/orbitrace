/// <reference types="node" />
/**
 * The single-writer lock of the history store (ticket #25): an owner-checked pid file.
 *
 * - Taking the lock writes `{ pid, hostname, token, acquiredAt }` to a temporary file and links
 *   it to the lock name. A link fails when the name exists, so exactly one process wins and the
 *   lock file is never seen half written. Where hard links are not supported the file is created
 *   with the exclusive flag instead.
 * - A lock held by a live process on this machine makes the second writer wait (up to `waitMs`)
 *   and then fail with `locked`. A lock whose process is gone is taken over: it is renamed away
 *   (atomic), checked to be the same stale lock, and deleted, then the lock is taken as usual.
 * - A lock written on another machine (shared folder) cannot be checked and counts as held.
 * - Release deletes the file only when it still holds this owner's token.
 * - Readers never take the lock; SQLite's WAL mode lets them read while a writer writes.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isProcessAlive, type ProcessAliveCheck } from "../sources/claude-code/registry.js";
import { HistoryStoreError } from "./errors.js";
import { HISTORY_FILE_MODE, restrictHistoryFile } from "./location.js";

/** What a lock file holds. */
export interface HistoryLockOwner {
  readonly pid: number;
  readonly hostname: string;
  /** Random, new for every acquisition. Two stores in one process have different tokens. */
  readonly token: string;
  /** Unix epoch milliseconds. */
  readonly acquiredAt: number;
}

export interface HistoryLockOptions {
  /** How long to wait for a live holder to let go, in milliseconds. Default 0: fail at once. */
  readonly waitMs?: number;
  /** Time between attempts while waiting, in milliseconds. Default 50. */
  readonly pollMs?: number;
  /** Liveness check for a holder's pid. Default `isProcessAlive`. */
  readonly isProcessAlive?: ProcessAliveCheck;
  /**
   * The owner token to write, instead of a new random one. Internal: `runHistoryIngestWorker`
   * makes the token before it starts the worker, so it can remove the worker's lock however the
   * worker ends. Must be unique per acquisition (see `newHistoryLockToken`).
   */
  readonly token?: string;
}

/** A new random owner token. */
export function newHistoryLockToken(): string {
  return randomBytes(16).toString("hex");
}

/** The temporary and set-aside files an owner with `token` may create beside `file`. */
export function historyLockSideFiles(
  file: string,
  token: string,
): { readonly temp: string; readonly aside: string } {
  return { temp: `${file}.${token}.tmp`, aside: `${file}.${token}.stale` };
}

/** A held lock. */
export interface HistoryLock {
  readonly owner: HistoryLockOwner;
  /** Whether the lock file still holds this owner's token. */
  isHeld(): boolean;
  /** Delete the lock file if it is still this owner's. Safe to call more than once. */
  release(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function parseOwner(text: string): HistoryLockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<HistoryLockOwner> | null;
    if (
      value !== null &&
      typeof value === "object" &&
      typeof value.pid === "number" &&
      typeof value.hostname === "string" &&
      typeof value.token === "string" &&
      typeof value.acquiredAt === "number"
    ) {
      return value as HistoryLockOwner;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

/** The owner recorded in a lock file, or null when it is missing or unreadable. */
export function readHistoryLockOwner(file: string): HistoryLockOwner | null {
  try {
    return parseOwner(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

const FILE_OPTIONS = { mode: HISTORY_FILE_MODE, encoding: "utf8" } as const;

/** Try to create the lock file. True when this owner now holds it. */
function tryCreate(file: string, owner: HistoryLockOwner): boolean {
  const text = JSON.stringify(owner);
  const { temp } = historyLockSideFiles(file, owner.token);
  writeFileSync(temp, text, { ...FILE_OPTIONS, flag: "wx" });
  restrictHistoryFile(temp);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    // No hard links here (some network and FAT file systems): exclusive create instead.
    try {
      writeFileSync(file, text, { ...FILE_OPTIONS, flag: "wx" });
      restrictHistoryFile(file);
      return true;
    } catch (inner) {
      if (errorCode(inner) === "EEXIST") return false;
      throw inner;
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
  }
}

/** Whether a recorded owner is a live process (or cannot be checked, which counts as live). */
function holderIsLive(holder: HistoryLockOwner, alive: ProcessAliveCheck): boolean {
  if (holder.hostname !== hostname()) return true;
  return alive(holder.pid);
}

/**
 * Remove a stale lock whose content is `staleText`. Renames it away first, so a fresh lock that
 * another process created in the meantime is put back instead of deleted.
 */
function removeStale(file: string, staleText: string, token: string): void {
  const { aside } = historyLockSideFiles(file, token);
  try {
    renameSync(file, aside);
  } catch {
    return; // Someone else removed it first.
  }
  let movedText: string | null;
  try {
    movedText = readFileSync(aside, "utf8");
  } catch {
    movedText = null;
  }
  if (movedText === staleText) {
    try {
      unlinkSync(aside);
    } catch {
      // Already gone.
    }
    return;
  }
  // Not the lock we judged stale: put it back if the name is still free.
  try {
    linkSync(aside, file);
  } catch {
    // The name was taken again; the lock under it is the current one.
  }
  try {
    unlinkSync(aside);
  } catch {
    // Already gone.
  }
}

/**
 * Take the writer lock at `file`. Waits up to `waitMs` for a live holder, takes over a lock left
 * by a dead process, and throws `locked` when the lock is still held at the end. Throws `io` when
 * the lock file cannot be written.
 */
export async function acquireHistoryLock(
  file: string,
  options: HistoryLockOptions = {},
): Promise<HistoryLock> {
  const waitMs = Math.max(0, options.waitMs ?? 0);
  const pollMs = Math.max(1, options.pollMs ?? 50);
  const alive = options.isProcessAlive ?? isProcessAlive;
  // The token is part of the side files' names: hex only.
  if (options.token !== undefined && !/^[0-9a-f]{16,64}$/.test(options.token)) {
    throw new HistoryStoreError("io", "The history lock token is not valid.");
  }
  const owner: HistoryLockOwner = {
    pid: process.pid,
    hostname: hostname(),
    token: options.token ?? newHistoryLockToken(),
    acquiredAt: Date.now(),
  };
  const deadline = Date.now() + waitMs;
  let lastHolder: HistoryLockOwner;
  for (;;) {
    let created: boolean;
    try {
      created = tryCreate(file, owner);
    } catch {
      throw new HistoryStoreError("io", "The history lock file could not be written.");
    }
    if (created) {
      const lock: HistoryLock = {
        owner,
        isHeld: () => readHistoryLockOwner(file)?.token === owner.token,
        release: () => {
          if (readHistoryLockOwner(file)?.token !== owner.token) return;
          try {
            unlinkSync(file);
          } catch {
            // Already gone.
          }
        },
      };
      if (lock.isHeld()) return lock;
      continue;
    }
    let text: string | null;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // Released between the two calls: try again.
    }
    const holder = parseOwner(text);
    if (holder === null || !holderIsLive(holder, alive)) {
      removeStale(file, text, owner.token);
      continue;
    }
    lastHolder = holder;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  const where =
    lastHolder.hostname !== owner.hostname
      ? "a process on another computer"
      : `process ${lastHolder.pid}`;
  throw new HistoryStoreError(
    "locked",
    `The history store is being written by ${where}. Try again when it has finished.`,
  );
}
