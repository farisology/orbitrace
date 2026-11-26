/// <reference types="node" />
/**
 * The optional live session registry, `<config>/sessions/<pid>.json`. Undocumented and seen
 * on one machine only: every read is tolerant, and an entry is trusted only while its process
 * is alive.
 *
 * Node only (the default liveness check uses `process.kill`). Exported from
 * `@orbitrace/core/node`.
 */

import type { RawLiveRegistryEntry } from "../../model/raw.js";
import type { LiveStatus } from "../../model/sources.js";
import type { PathApi } from "./paths.js";
import type { SourceFileSystem } from "./fs.js";

/** Checks whether a process id belongs to a running process. */
export type ProcessAliveCheck = (pid: number) => boolean;

/** One registry entry with the liveness of its process, checked once when read. */
export interface LiveRegistryRecord {
  readonly entry: RawLiveRegistryEntry;
  readonly pid: number | null;
  readonly alive: boolean;
  /** Newest of `updatedAt` and `statusUpdatedAt`, epoch milliseconds, or null. */
  readonly updatedAt: number | null;
}

export interface LiveRegistry {
  /** False when the registry folder is missing or unreadable: the runtime does not write one. */
  readonly present: boolean;
  /** Best record per session id: a live one first, then the most recently updated. */
  readonly bySessionId: ReadonlyMap<string, LiveRegistryRecord>;
}

export const EMPTY_LIVE_REGISTRY: LiveRegistry = { present: false, bySessionId: new Map() };

/**
 * Whether a process is running, with `process.kill(pid, 0)`, which sends no signal. Only a
 * positive integer is checked: 0 and negative values address process groups, never a session.
 * A permission error means the process exists but belongs to another user, so it counts as
 * alive. A process id can be reused after its process ends; this check cannot tell.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A registry time as epoch milliseconds. Accepts ISO 8601 strings and numbers or numeric
 * strings in seconds or milliseconds (values below 1e11 are taken as seconds). Returns null
 * for anything else.
 */
export function registryTime(value: unknown): number | null {
  let numeric: number | null = null;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) numeric = Number(trimmed);
    else {
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (numeric === null || !Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1e11 ? Math.round(numeric * 1000) : Math.round(numeric);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newer(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function better(candidate: LiveRegistryRecord, current: LiveRegistryRecord | undefined): boolean {
  if (current === undefined) return true;
  if (candidate.alive !== current.alive) return candidate.alive;
  return (candidate.updatedAt ?? 0) > (current.updatedAt ?? 0);
}

/**
 * Read every `<pid>.json` in a registry folder. Malformed files and entries without a session
 * id are skipped. The process id comes from the entry, or from the file name when the entry
 * has none.
 */
export async function readLiveRegistry(
  fs: SourceFileSystem,
  p: PathApi,
  sessionsDir: string,
  alive: ProcessAliveCheck,
): Promise<LiveRegistry> {
  let entries;
  try {
    entries = await fs.readDir(sessionsDir);
  } catch {
    return EMPTY_LIVE_REGISTRY;
  }
  const bySessionId = new Map<string, LiveRegistryRecord>();
  for (const dirEntry of entries) {
    if (!dirEntry.isFile || !dirEntry.name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readText(p.join(sessionsDir, dirEntry.name)));
    } catch {
      continue;
    }
    if (!isRecordObject(parsed)) continue;
    const entry = parsed as RawLiveRegistryEntry;
    if (typeof entry.sessionId !== "string" || entry.sessionId === "") continue;
    const fromName = /^(\d+)\.json$/.exec(dirEntry.name)?.[1];
    const pid =
      typeof entry.pid === "number" && Number.isSafeInteger(entry.pid)
        ? entry.pid
        : fromName === undefined
          ? null
          : Number(fromName);
    const record: LiveRegistryRecord = {
      entry,
      pid,
      alive: pid !== null && alive(pid),
      updatedAt: newer(registryTime(entry.updatedAt), registryTime(entry.statusUpdatedAt)),
    };
    if (better(record, bySessionId.get(entry.sessionId))) bySessionId.set(entry.sessionId, record);
  }
  return { present: true, bySessionId };
}

/**
 * Live status of one session. `busy` or `idle` need a live process; another status from a
 * live process is `unknown`. A dead process, or no entry while the registry exists, is
 * `ended`. Without a registry the status is `unknown`.
 */
export function liveStatusOf(registry: LiveRegistry, sessionId: string): LiveStatus {
  if (!registry.present) return "unknown";
  const record = registry.bySessionId.get(sessionId);
  if (record === undefined || !record.alive) return "ended";
  const status = record.entry.status;
  return status === "busy" || status === "idle" ? status : "unknown";
}
