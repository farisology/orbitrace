/**
 * Source resolution and session listing across adapters (ticket #7). Browser-safe: this file
 * imports no Node module. The Claude Code adapter, which reads files, is exported from the
 * `@orbitrace/core/node` subpath instead, so the browser bundle of core never pulls in Node.
 */

import type { ListSessions, ResolveSources } from "../api.js";
import {
  SOURCE_RESOLUTIONS,
  type ListSessionsOptions,
  type RuntimeId,
  type SessionRef,
  type SessionSummary,
  type SourceAdapter,
  type SourceResolution,
  type SourceRoot,
} from "../model/sources.js";

const RESOLUTION_RANK: ReadonlyMap<SourceResolution, number> = new Map(
  SOURCE_RESOLUTIONS.map((resolution, index) => [resolution, index]),
);

function rankOf(resolution: SourceResolution): number {
  return RESOLUTION_RANK.get(resolution) ?? SOURCE_RESOLUTIONS.length;
}

/** True for `C:\`, `C:/` and `\\server\share` style paths. */
function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * Identity of a root for removing duplicates across adapters: runtime plus the path without
 * trailing separators, case-folded for Windows paths. Adapters remove their own duplicates
 * with stronger checks (real paths); this only catches what is left.
 */
export function sourceRootKey(root: Pick<SourceRoot, "runtime" | "root">): string {
  let path = root.root;
  while (path.length > 1 && /[\\/]$/.test(path) && !/^[A-Za-z]:[\\/]$/.test(path)) {
    path = path.slice(0, -1);
  }
  if (looksLikeWindowsPath(path)) path = path.replace(/\//g, "\\").toLowerCase();
  return `${root.runtime}\u0000${path}`;
}

/**
 * Ask each adapter for its roots and return them in resolution order (user setting,
 * environment, OS default, extra roots, hooks), duplicates removed. Within one resolution the
 * adapter order and each adapter's own order are kept. The first occurrence of a root wins, so
 * a root keeps the highest-priority reason it was found by.
 */
export const resolveSources: ResolveSources = async (context, adapters) => {
  const lists = await Promise.all(adapters.map((adapter) => adapter.resolveRoots(context)));
  const ordered = lists.flat().sort((a, b) => rankOf(a.resolvedBy) - rankOf(b.resolvedBy));
  const seen = new Set<string>();
  const roots: SourceRoot[] = [];
  for (const root of ordered) {
    const key = sourceRootKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
};

/** Normalised options: a usable `since` and a non-negative integer `limit`, or undefined. */
export function normalizeListOptions(options: ListSessionsOptions = {}): {
  since: number | undefined;
  limit: number | undefined;
} {
  const since =
    typeof options.since === "number" && Number.isFinite(options.since) ? options.since : undefined;
  const limit =
    typeof options.limit === "number" && !Number.isNaN(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : undefined;
  return { since, limit };
}

/** Newest first; equal times are ordered by key so the result is stable. */
export function compareSessionsNewestFirst(a: SessionRef, b: SessionRef): number {
  if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * List sessions under the given roots, newest first, using the adapter whose `runtime`
 * matches each root (the first such adapter). A root without a matching adapter, or whose
 * adapter fails, yields no sessions rather than an error. A session reached through two roots
 * is listed once, under the root that comes first.
 */
export const listSessions: ListSessions = async (roots, adapters, options = {}) => {
  const { since, limit } = normalizeListOptions(options);
  if (limit === 0) return [];
  const byRuntime = new Map<RuntimeId, SourceAdapter>();
  for (const adapter of adapters) {
    if (!byRuntime.has(adapter.runtime)) byRuntime.set(adapter.runtime, adapter);
  }
  const adapterOptions: ListSessionsOptions = {
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limit }),
  };
  const perRoot = await Promise.all(
    roots.map(async (root): Promise<readonly SessionRef[]> => {
      const adapter = byRuntime.get(root.runtime);
      if (adapter === undefined) return [];
      try {
        return await adapter.listSessions(root, adapterOptions);
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const sessions: SessionRef[] = [];
  for (const ref of perRoot.flat()) {
    if (seen.has(ref.key)) continue;
    if (since !== undefined && ref.lastActivity < since) continue;
    seen.add(ref.key);
    sessions.push(ref);
  }
  sessions.sort(compareSessionsNewestFirst);
  return limit === undefined ? sessions : sessions.slice(0, limit);
};

/**
 * The path-free part of a session for a host transport: no root, no locator. Fields are
 * picked one by one, so a field added to `SessionRef` later does not leak through.
 */
export function toSessionSummary(ref: SessionRef): SessionSummary {
  return {
    key: ref.key,
    runtime: ref.runtime,
    projectLabel: ref.projectLabel,
    sessionId: ref.sessionId,
    lastActivity: ref.lastActivity,
    live: ref.live,
    subagentCount: ref.subagentCount,
  };
}

const CONFIG_ENV_VAR: Readonly<Record<RuntimeId, string>> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
};

/**
 * Why a root was chosen, as one plain sentence for the doctor command. Path-free: the caller
 * prints `root.root` itself if it wants to show the path on the user's own screen.
 */
export function describeResolution(
  root: Pick<SourceRoot, "runtime" | "resolvedBy" | "available">,
): string {
  let reason: string;
  switch (root.resolvedBy) {
    case "user-setting":
      reason = "Set explicitly by the user (a setting or a command-line option).";
      break;
    case "environment":
      reason = `Taken from the ${CONFIG_ENV_VAR[root.runtime]} environment variable.`;
      break;
    case "os-default":
      reason = "The default config folder for this operating system.";
      break;
    case "extra-root":
      reason = "An extra folder found because extra roots are switched on (desktop app sessions).";
      break;
    case "hook":
      reason = "Worked out from a transcript path reported by a hook.";
      break;
  }
  return root.available ? reason : `${reason} The folder was missing or not readable.`;
}
