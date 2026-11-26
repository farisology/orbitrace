/// <reference types="node" />
/**
 * Watching the files of one Claude Code session for changes (ticket #74). The adapter's
 * `watchSession` sits on top of this and turns each change into a fresh `SessionRef`.
 *
 * What is watched: the main transcript, every `agent-<agentId>.jsonl` and
 * `agent-<agentId>.meta.json` in the session's `subagents/` folder, and the live registry
 * folder (`<config>/sessions`). Folders are watched, never single files, so a file that is
 * replaced (written to a temporary name and renamed over the old one) or created later is still
 * seen. The `<session-id>/` and `subagents/` folders may not exist when the watch starts; the
 * folder above reports when they appear, and they are watched from then on.
 *
 * How a change is decided: an event only schedules a check. A check takes the size, modified
 * time and inode of each watched file and compares them with the last check. Only a difference
 * is reported, so duplicate events, events for other sessions in the same project folder and
 * events a platform delivers late never reach the listener. The watchers open and the first
 * snapshot is taken synchronously when the watch starts, so nothing written after
 * `watchSessionFiles` returns is missed.
 *
 * Debounce: events are merged until `debounceMs` pass without one, but a check runs at least
 * every `maxWaitMs` while events keep coming, so a session that writes without pause is still
 * reported.
 *
 * Events or polling, and how the default was chosen (`mode`):
 * - `fs.watch` is fast but not reliable everywhere: on network drives (SMB, NFS) and in some
 *   containers and virtual machines it starts without error and then reports nothing, and on
 *   Linux it throws once the inotify watch limit is reached. A silent watcher cannot be detected,
 *   so the default, `auto`, uses events for speed and keeps a slow polling check
 *   (`backstopIntervalMs`) running beside them. Where `fs.watch` throws or reports an error for a
 *   folder, that folder has no watcher and the check runs every `pollIntervalMs` instead, until a
 *   later check opens a watcher again.
 * - `poll` opens no watcher and checks every `pollIntervalMs`. A host offers it as a setting for
 *   file systems where events are known not to work.
 * - `events` uses `fs.watch` only, with no backstop. It still polls while a folder could not be
 *   watched.
 *
 * While it runs, a watch keeps a Node process alive, like an open server. Every handle (watchers,
 * timers) is released by the function returned; calling it twice is safe. Reads only, never
 * writes.
 *
 * Node only. Exported from `@orbitrace/core/node`.
 */

import { readdirSync, statSync, watch, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Unsubscribe } from "../../model/sources.js";

/** How changes are noticed. See the module comment for the trade-offs. */
export const SESSION_WATCH_MODES = ["auto", "events", "poll"] as const;

export type SessionWatchMode = (typeof SESSION_WATCH_MODES)[number];

/** The paths of one session to watch. Absolute paths on this machine. Local only. */
export interface SessionWatchTargets {
  /** The main transcript, `<project>/<session-id>.jsonl`. Its folder is watched. */
  readonly transcript: string;
  /** `<project>/<session-id>`, the folder that holds `subagents/`. May not exist yet. */
  readonly sessionDir: string;
  /** `<project>/<session-id>/subagents`. May not exist yet. */
  readonly subagentsDir: string;
  /** The live registry folder, `<config>/sessions`, or null to leave it out. */
  readonly registryDir: string | null;
}

/** What differed from the previous check. At least one field is true. */
export interface SessionFilesChange {
  /** The main transcript, a subagent transcript or a meta file grew, appeared, went away or was replaced. */
  readonly files: boolean;
  /** A file in the live registry folder changed. It may belong to another session. */
  readonly registry: boolean;
}

/** A started folder watcher. `close` releases it. */
export interface DirectoryWatcher {
  close(): void;
}

/**
 * Opens a watcher on one folder. `onEvent` gets the name of the entry that changed, or null when
 * the platform does not say. `onError` is called when the watcher fails after it started. May
 * throw when the folder cannot be watched. The default uses `fs.watch`.
 */
export type DirectoryWatchOpener = (
  dir: string,
  onEvent: (filename: string | null) => void,
  onError: () => void,
) => DirectoryWatcher;

export interface SessionWatchOptions {
  /** Default `auto`. */
  readonly mode?: SessionWatchMode;
  /** Quiet time that ends a burst of events, milliseconds. Default 100. */
  readonly debounceMs?: number;
  /** Longest wait for a check while events keep coming, milliseconds. Default 1000. */
  readonly maxWaitMs?: number;
  /** Check interval when polling is the only signal (`poll`, or a folder without a watcher). Default 1000. */
  readonly pollIntervalMs?: number;
  /** Check interval beside working watchers in `auto` mode. 0 turns it off. Default 5000. */
  readonly backstopIntervalMs?: number;
  /** Folder watcher factory. For tests and hosts with their own file events. Default `fs.watch`. */
  readonly openWatcher?: DirectoryWatchOpener;
}

/** Watch one session's files. `onChange` is called once per detected change, never after the returned function is called. */
export type SessionFilesWatcher = (
  targets: SessionWatchTargets,
  onChange: (change: SessionFilesChange) => void,
  options?: SessionWatchOptions,
) => Unsubscribe;

const DEFAULTS = {
  debounceMs: 100,
  maxWaitMs: 1000,
  pollIntervalMs: 1000,
  backstopIntervalMs: 5000,
} as const;

/** Subagent transcripts and their meta files. Other entries in `subagents/` are ignored. */
const SUBAGENT_ENTRY = /^agent-.+\.(?:jsonl|meta\.json)$/;

/** A folder watcher on `fs.watch`. File names arrive as UTF-8 strings. */
export const openNodeDirectoryWatcher: DirectoryWatchOpener = (dir, onEvent, onError) => {
  const watcher = watch(dir, { persistent: true }, (_event, filename) => {
    onEvent(typeof filename === "string" && filename !== "" ? filename : null);
  });
  watcher.on("error", onError);
  return watcher;
};

/** Non-negative finite number, or the default. */
function duration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

interface StatLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly identity: string;
  readonly signature: string;
}

function statLike(info: Stats): StatLike {
  return {
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    identity: `${info.dev}:${info.ino}`,
    signature: `${info.size}:${info.mtimeMs}:${info.ino}`,
  };
}

/** One check's view of the session: a signature per group and the identity of each folder. */
interface Snapshot {
  readonly files: string;
  readonly registry: string;
  /** Folder path -> `dev:ino`, or null when it is missing or not a folder. */
  readonly dirs: ReadonlyMap<string, string | null>;
}

/** The folder names read and the paths statted by one check, in order. */
interface Plan {
  readonly subagents: readonly string[];
  readonly registry: readonly string[];
  readonly stats: readonly string[];
}

/** Watch one Claude Code session's files. See the module comment. */
export const watchSessionFiles: SessionFilesWatcher = (targets, onChange, options = {}) => {
  const mode: SessionWatchMode = SESSION_WATCH_MODES.includes(options.mode as SessionWatchMode)
    ? (options.mode as SessionWatchMode)
    : "auto";
  const debounceMs = duration(options.debounceMs, DEFAULTS.debounceMs);
  const maxWaitMs = Math.max(debounceMs, duration(options.maxWaitMs, DEFAULTS.maxWaitMs));
  const pollIntervalMs = Math.max(1, duration(options.pollIntervalMs, DEFAULTS.pollIntervalMs));
  const backstopIntervalMs = duration(options.backstopIntervalMs, DEFAULTS.backstopIntervalMs);
  const openWatcher = options.openWatcher ?? openNodeDirectoryWatcher;

  const projectDir = dirname(targets.transcript);
  const transcriptName = basename(targets.transcript);
  const sessionDirName = basename(targets.sessionDir);
  const subagentsDirName = basename(targets.subagentsDir);
  const registryDir = targets.registryDir;
  const dirs = [projectDir, targets.sessionDir, targets.subagentsDir];
  if (registryDir !== null) dirs.push(registryDir);

  /** Which events in a folder are worth a check. The project folder holds other sessions too. */
  const relevant = (dir: string, name: string | null): boolean => {
    if (name === null) return true;
    if (dir === projectDir) return name === transcriptName || name === sessionDirName;
    if (dir === registryDir) return name.endsWith(".json");
    return true;
  };

  const watchers = new Map<string, { watcher: DirectoryWatcher; identity: string }>();
  /**
   * Child folders whose watcher is reopened at the next check, because the folder above reported
   * an event naming them: they may have been removed and created again. The inode check alone
   * misses that when the file system hands the new folder the old inode number (ext4 can).
   */
  const reopen = new Set<string>();
  let stopped = false;
  let last: Snapshot;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let burstStart: number | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let checkAgain = false;

  function plan(subagents: readonly string[] | null, registry: readonly string[] | null): Plan {
    const sub = (subagents ?? []).filter((name) => SUBAGENT_ENTRY.test(name)).sort();
    const reg = (registry ?? []).filter((name) => name.endsWith(".json")).sort();
    return {
      subagents: sub,
      registry: reg,
      stats: [
        targets.transcript,
        ...sub.map((name) => join(targets.subagentsDir, name)),
        ...(registryDir === null ? [] : reg.map((name) => join(registryDir, name))),
        ...dirs,
      ],
    };
  }

  function snapshotOf(p: Plan, stats: readonly (StatLike | null)[]): Snapshot {
    const fileSig = (info: StatLike | null | undefined): string =>
      info !== null && info !== undefined && info.isFile ? info.signature : "-";
    let index = 0;
    const files = [`main=${fileSig(stats[index++])}`];
    for (const name of p.subagents) files.push(`${name}=${fileSig(stats[index++])}`);
    const registry: string[] = [];
    for (const name of p.registry) registry.push(`${name}=${fileSig(stats[index++])}`);
    const dirIds = new Map<string, string | null>();
    for (const dir of dirs) {
      const info = stats[index++];
      dirIds.set(
        dir,
        info !== null && info !== undefined && info.isDirectory ? info.identity : null,
      );
    }
    return { files: files.join("\n"), registry: registry.join("\n"), dirs: dirIds };
  }

  function snapshotSync(): Snapshot {
    const list = (dir: string | null): string[] | null => {
      if (dir === null) return null;
      try {
        return readdirSync(dir);
      } catch {
        return null;
      }
    };
    const p = plan(list(targets.subagentsDir), list(registryDir));
    return snapshotOf(
      p,
      p.stats.map((path) => {
        try {
          return statLike(statSync(path));
        } catch {
          return null;
        }
      }),
    );
  }

  async function snapshot(): Promise<Snapshot> {
    const list = async (dir: string | null): Promise<string[] | null> => {
      if (dir === null) return null;
      try {
        return await readdir(dir);
      } catch {
        return null;
      }
    };
    const [subagents, registry] = await Promise.all([
      list(targets.subagentsDir),
      list(registryDir),
    ]);
    const p = plan(subagents, registry);
    const stats = await Promise.all(
      p.stats.map(async (path) => {
        try {
          return statLike(await stat(path));
        } catch {
          return null;
        }
      }),
    );
    return snapshotOf(p, stats);
  }

  function closeWatcher(dir: string): void {
    const entry = watchers.get(dir);
    if (entry === undefined) return;
    watchers.delete(dir);
    try {
      entry.watcher.close();
    } catch {
      // Already closed or never fully opened.
    }
  }

  /**
   * Open watchers on folders that exist and have none; drop those whose folder went away or was
   * replaced. Returns true when a watcher was opened.
   */
  function arm(dirIds: ReadonlyMap<string, string | null>): boolean {
    if (mode === "poll") return false;
    let opened = false;
    for (const dir of dirs) {
      const identity = dirIds.get(dir) ?? null;
      const current = watchers.get(dir);
      if (current !== undefined && current.identity === identity && !reopen.has(dir)) continue;
      reopen.delete(dir);
      closeWatcher(dir);
      if (identity === null) continue;
      try {
        const watcher = openWatcher(
          dir,
          (name) => {
            if (stopped || !relevant(dir, name)) return;
            if (dir === projectDir && name === sessionDirName) {
              reopen.add(targets.sessionDir);
              reopen.add(targets.subagentsDir);
            } else if (dir === targets.sessionDir && name === subagentsDirName) {
              reopen.add(targets.subagentsDir);
            }
            trigger();
          },
          () => {
            // The watcher broke (for example its folder was removed). Poll until a check
            // opens a new one.
            if (stopped) return;
            if (watchers.get(dir)?.watcher === watcher) closeWatcher(dir);
            trigger();
          },
        );
        if (stopped) {
          watcher.close();
          return false;
        }
        watchers.set(dir, { watcher, identity });
        opened = true;
      } catch {
        // fs.watch is not available for this folder (limit reached, unsupported file
        // system). It stays without a watcher and the check falls back to polling.
      }
    }
    return opened;
  }

  /** True when every folder that exists has a watcher, so events alone can be trusted. */
  function eventsCoverEverything(): boolean {
    if (mode === "poll") return false;
    if (last.dirs.get(projectDir) === null) return false;
    for (const dir of dirs) {
      if (last.dirs.get(dir) !== null && !watchers.has(dir)) return false;
    }
    return true;
  }

  function schedulePoll(): void {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (stopped) return;
    let interval: number;
    if (!eventsCoverEverything()) interval = pollIntervalMs;
    else if (mode === "auto" && backstopIntervalMs > 0) interval = backstopIntervalMs;
    else return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void check();
    }, interval);
  }

  function deliver(change: SessionFilesChange): void {
    try {
      onChange(change);
    } catch (error) {
      // A throwing listener must not stop the watch; its error is not swallowed either.
      void Promise.reject(error);
    }
  }

  /** Compare the files with the last check and report a difference. One check runs at a time. */
  async function check(): Promise<void> {
    if (stopped) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      do {
        checkAgain = false;
        const next = await snapshot();
        if (stopped) return;
        // A folder that just got its watcher may have gained entries before the watcher was
        // open; look once more so they are not left for the next event.
        if (arm(next.dirs)) checkAgain = true;
        const files = next.files !== last.files;
        const registry = next.registry !== last.registry;
        last = next;
        if (files || registry) deliver({ files, registry });
      } while (checkAgain && !stopped);
    } finally {
      checking = false;
      schedulePoll();
    }
  }

  /** Called for each relevant event: wait for the burst to end, then check once. */
  function trigger(): void {
    if (stopped) return;
    const now = Date.now();
    if (burstStart === undefined) burstStart = now;
    const wait = Math.max(0, Math.min(debounceMs, burstStart + maxWaitMs - now));
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      burstStart = undefined;
      void check();
    }, wait);
  }

  // Watchers first, then the first snapshot: anything written after this point either raises an
  // event or is already in the snapshot.
  const startDirs = new Map<string, string | null>();
  for (const dir of dirs) {
    let identity: string | null = null;
    try {
      const info = statLike(statSync(dir));
      if (info.isDirectory) identity = info.identity;
    } catch {
      // Missing: watched once a check sees it.
    }
    startDirs.set(dir, identity);
  }
  arm(startDirs);
  last = snapshotSync();
  schedulePoll();

  return () => {
    if (stopped) return;
    stopped = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    debounceTimer = undefined;
    pollTimer = undefined;
    for (const dir of [...watchers.keys()]) closeWatcher(dir);
  };
};
