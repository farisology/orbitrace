/// <reference types="node" />
/**
 * The Claude Code `SourceAdapter` (ticket #7).
 *
 * Layout read (documented by Anthropic unless marked):
 * - `<config>/projects/<project>/<session-id>.jsonl`, the main transcript;
 * - `<config>/projects/<project>/<session-id>/subagents/agent-<agentId>.jsonl` and
 *   `agent-<agentId>.meta.json`, subagent transcripts;
 * - `<config>/sessions/<pid>.json`, the live registry (undocumented, optional);
 * - desktop app config roots under `<app data>/Claude/local-agent-mode-sessions/` (undocumented,
 *   opt in).
 *
 * Reads only, never writes. Every read failure is treated as "not there".
 *
 * Node only. Exported from `@orbitrace/core/node`.
 */

import { createHash } from "node:crypto";
import type {
  RawSubagentInput,
  RawSubagentMeta,
  SessionInput,
  LineSource,
} from "../../model/raw.js";
import type {
  ListSessionsOptions,
  ResolveRootsContext,
  SessionRef,
  SourceAdapter,
  SourceResolution,
  SourceRoot,
} from "../../model/sources.js";
import { compareSessionsNewestFirst, normalizeListOptions } from "../index.js";
import { createNodeFileSystem, type SourceDirEntry, type SourceFileSystem } from "./fs.js";
import {
  configRootFromTranscriptPath,
  defaultConfigRoot,
  desktopSessionBases,
  environmentConfigRoot,
  normalizeRoot,
  pathApiFor,
  pathApiForPath,
  platformForPath,
  projectLabelFromCwd,
  projectLabelFromFolderName,
  rootIdentity,
  userConfigRoot,
  type PathApi,
} from "./paths.js";
import {
  isProcessAlive,
  liveStatusOf,
  readLiveRegistry,
  type LiveRegistry,
  type ProcessAliveCheck,
} from "./registry.js";

export interface ClaudeCodeAdapterOptions {
  /** File access. Default: Node's file system. */
  readonly fs?: SourceFileSystem;
  /** Process liveness check for the live registry. Default: `isProcessAlive`. */
  readonly isProcessAlive?: ProcessAliveCheck;
  /** Most folders visited when scanning desktop app folders for config roots. Default 2000. */
  readonly extraRootScanLimit?: number;
  /** Deepest folder level searched below a desktop sessions folder. Default 6. */
  readonly extraRootScanDepth?: number;
  /** Bytes read from the start of a transcript to find its working directory. Default 65536. */
  readonly headBytes?: number;
}

export const CLAUDE_CODE_RUNTIME = "claude-code" as const;

const TRANSCRIPT_SUFFIX = ".jsonl";
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;
/** Transcript heads read per project folder when looking for its working directory. */
const HEAD_READS_PER_PROJECT = 3;

async function tryReadDir(
  fs: SourceFileSystem,
  dir: string,
): Promise<readonly SourceDirEntry[] | null> {
  try {
    return await fs.readDir(dir);
  } catch {
    return null;
  }
}

async function tryMtime(fs: SourceFileSystem, file: string): Promise<number | null> {
  try {
    const info = await fs.stat(file);
    return info.isFile ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

function byName(a: SourceDirEntry, b: SourceDirEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Stable, opaque session key. A hash, so it carries no path or project name across a host
 * transport; it includes the root so the same session id under two roots gets two keys.
 */
export function claudeCodeSessionKey(
  rootPath: string,
  projectFolder: string,
  sessionId: string,
): string {
  const identity = rootIdentity(rootPath, platformForPath(rootPath));
  const digest = createHash("sha256")
    .update(`${identity}\u0000${projectFolder}\u0000${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `${CLAUDE_CODE_RUNTIME}:${digest}`;
}

/**
 * The working directory recorded in the first lines of a transcript, or null. Only the `cwd`
 * key is used; the rest of each line is discarded.
 */
export function cwdFromTranscriptHead(head: string): string | null {
  const lines = head.split(/\r?\n/);
  // The last piece may be a line cut off by the byte limit; JSON.parse rejects it.
  for (const line of lines) {
    if (!line.includes('"cwd"')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const cwd = (value as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd !== "") return cwd;
      }
    } catch {
      // Malformed or cut-off line.
    }
  }
  return null;
}

function lazyLines(fs: SourceFileSystem, file: string): LineSource {
  return {
    [Symbol.asyncIterator]: () => fs.readLines(file)[Symbol.asyncIterator](),
  };
}

function isMetaObject(value: unknown): value is RawSubagentMeta {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Candidate {
  readonly root: string;
  readonly resolvedBy: SourceResolution;
  /** Only a user setting is checked for pointing at the `projects` folder itself. */
  readonly mayBeProjectsFolder: boolean;
}

interface PendingSession {
  readonly projectFolder: string;
  readonly projectDir: string;
  readonly sessionId: string;
  readonly locator: string;
  readonly lastActivity: number;
  readonly subagentCount: number;
}

/** Create a Claude Code adapter. Options exist for tests and other hosts; the defaults use Node. */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): SourceAdapter {
  const fs = options.fs ?? createNodeFileSystem();
  const alive = options.isProcessAlive ?? isProcessAlive;
  const scanLimit = options.extraRootScanLimit ?? 2000;
  const scanDepth = options.extraRootScanDepth ?? 6;
  const headBytes = options.headBytes ?? 65536;

  async function isReadableDir(dir: string): Promise<boolean> {
    return (await tryReadDir(fs, dir)) !== null;
  }

  /** Config roots (folders holding `projects/`) below a desktop sessions folder, sorted. */
  async function scanDesktopBase(p: PathApi, base: string): Promise<string[]> {
    const found: string[] = [];
    let queue: string[] = [base];
    let visited = 0;
    for (let depth = 0; depth <= scanDepth && queue.length > 0; depth += 1) {
      const next: string[] = [];
      for (const dir of queue) {
        if (visited >= scanLimit) return found;
        visited += 1;
        const entries = await tryReadDir(fs, dir);
        if (entries === null) continue;
        const folders = entries.filter((entry) => entry.isDirectory).sort(byName);
        if (depth > 0 && folders.some((entry) => entry.name === "projects")) {
          found.push(dir);
          continue;
        }
        for (const folder of folders) next.push(p.join(dir, folder.name));
      }
      queue = next;
    }
    return found;
  }

  async function resolveRoots(context: ResolveRootsContext): Promise<readonly SourceRoot[]> {
    const { platform, homeDir, env } = context;
    const p = pathApiFor(platform);
    const candidates: Candidate[] = [];
    const add = (
      root: string | null,
      resolvedBy: SourceResolution,
      mayBeProjectsFolder = false,
    ): void => {
      if (root !== null) candidates.push({ root, resolvedBy, mayBeProjectsFolder });
    };

    for (const value of context.userRoots ?? []) {
      add(userConfigRoot(value, platform, homeDir, env), "user-setting", true);
    }
    add(environmentConfigRoot(platform, homeDir, env), "environment");
    add(defaultConfigRoot(platform, homeDir, env), "os-default");
    if (context.includeExtraRoots === true) {
      for (const base of desktopSessionBases(platform, homeDir, env)) {
        for (const root of await scanDesktopBase(p, base))
          add(normalizeRoot(root, platform), "extra-root");
      }
    }
    for (const transcriptPath of context.hookTranscriptPaths ?? []) {
      add(configRootFromTranscriptPath(transcriptPath, platform), "hook");
    }

    const seen = new Set<string>();
    const roots: SourceRoot[] = [];
    for (const candidate of candidates) {
      let root = candidate.root;
      if (
        candidate.mayBeProjectsFolder &&
        p.basename(root) === "projects" &&
        !(await isReadableDir(p.join(root, "projects"))) &&
        (await isReadableDir(root))
      ) {
        root = p.dirname(root);
      }
      const available = await isReadableDir(root);
      const identities = [rootIdentity(root, platform)];
      if (available) {
        try {
          const real = normalizeRoot(await fs.realPath(root), platform);
          if (real !== null) identities.push(rootIdentity(real, platform));
        } catch {
          // Keep the plain identity.
        }
      }
      if (identities.some((identity) => seen.has(identity))) continue;
      for (const identity of identities) seen.add(identity);
      roots.push({
        runtime: CLAUDE_CODE_RUNTIME,
        root,
        resolvedBy: candidate.resolvedBy,
        available,
      });
    }
    return roots;
  }

  async function findSessions(
    p: PathApi,
    projectsDir: string,
    registry: LiveRegistry,
  ): Promise<PendingSession[]> {
    const projects = await tryReadDir(fs, projectsDir);
    if (projects === null) return [];
    const pending: PendingSession[] = [];
    for (const project of projects) {
      if (!project.isDirectory) continue;
      const projectDir = p.join(projectsDir, project.name);
      const files = await tryReadDir(fs, projectDir);
      if (files === null) continue;
      for (const file of files) {
        if (!file.isFile || !file.name.endsWith(TRANSCRIPT_SUFFIX)) continue;
        const sessionId = file.name.slice(0, -TRANSCRIPT_SUFFIX.length);
        if (sessionId === "") continue;
        const locator = p.join(projectDir, file.name);
        const mainTime = await tryMtime(fs, locator);
        if (mainTime === null) continue;
        let lastActivity = mainTime;
        let subagentCount = 0;
        const subagentDir = p.join(projectDir, sessionId, "subagents");
        for (const entry of (await tryReadDir(fs, subagentDir)) ?? []) {
          if (!entry.isFile || !SUBAGENT_FILE.test(entry.name)) continue;
          subagentCount += 1;
          const time = await tryMtime(fs, p.join(subagentDir, entry.name));
          if (time !== null && time > lastActivity) lastActivity = time;
        }
        const registryTime = registry.bySessionId.get(sessionId)?.updatedAt ?? null;
        if (registryTime !== null && registryTime > lastActivity) lastActivity = registryTime;
        pending.push({
          projectFolder: project.name,
          projectDir,
          sessionId,
          locator,
          lastActivity,
          subagentCount,
        });
      }
    }
    return pending;
  }

  async function listSessions(
    root: SourceRoot,
    listOptions: ListSessionsOptions = {},
  ): Promise<readonly SessionRef[]> {
    if (root.runtime !== CLAUDE_CODE_RUNTIME) return [];
    const { since, limit } = normalizeListOptions(listOptions);
    if (limit === 0) return [];
    const p = pathApiForPath(root.root);
    const registry = await readLiveRegistry(fs, p, p.join(root.root, "sessions"), alive);
    let pending = await findSessions(p, p.join(root.root, "projects"), registry);
    if (since !== undefined) pending = pending.filter((session) => session.lastActivity >= since);

    const entries = pending.map((session) => ({
      session,
      ref: {
        key: claudeCodeSessionKey(root.root, session.projectFolder, session.sessionId),
        runtime: CLAUDE_CODE_RUNTIME,
        source: root,
        projectLabel: "",
        sessionId: session.sessionId,
        lastActivity: session.lastActivity,
        live: liveStatusOf(registry, session.sessionId),
        subagentCount: session.subagentCount,
        locator: session.locator,
      } satisfies SessionRef,
    }));
    entries.sort((a, b) => compareSessionsNewestFirst(a.ref, b.ref));
    const kept = limit === undefined ? entries : entries.slice(0, limit);

    // Project labels only for the sessions returned: a registry cwd first, then the cwd in the
    // head of a transcript of the same project folder (this one, then its newest siblings),
    // then the encoded folder name. All sessions in a project folder share one cwd.
    const siblings = new Map<string, PendingSession[]>();
    for (const { session } of entries) {
      const list = siblings.get(session.projectDir) ?? [];
      list.push(session);
      siblings.set(session.projectDir, list);
    }
    const cwdByProject = new Map<string, string | null>();
    const projectCwd = async (session: PendingSession): Promise<string | null> => {
      const cached = cwdByProject.get(session.projectDir);
      if (cached !== undefined) return cached;
      const others = (siblings.get(session.projectDir) ?? []).filter((other) => other !== session);
      let found: string | null = null;
      for (const candidate of [session, ...others].slice(0, HEAD_READS_PER_PROJECT)) {
        try {
          found = cwdFromTranscriptHead(await fs.readHead(candidate.locator, headBytes));
        } catch {
          found = null;
        }
        if (found !== null) break;
      }
      cwdByProject.set(session.projectDir, found);
      return found;
    };
    const result: SessionRef[] = [];
    for (const { session, ref } of kept) {
      const registryCwd = registry.bySessionId.get(ref.sessionId)?.entry.cwd;
      const cwd =
        typeof registryCwd === "string" && registryCwd !== ""
          ? registryCwd
          : await projectCwd(session);
      const label =
        (cwd === null ? null : projectLabelFromCwd(cwd)) ??
        projectLabelFromFolderName(session.projectFolder);
      result.push({ ...ref, projectLabel: label });
    }
    return result;
  }

  async function openSession(ref: SessionRef): Promise<SessionInput> {
    const p = pathApiForPath(ref.locator);
    if ((await tryMtime(fs, ref.locator)) === null) {
      throw new Error("Session transcript not found or not readable.");
    }
    const subagentDir = p.join(p.dirname(ref.locator), ref.sessionId, "subagents");
    const entries = ((await tryReadDir(fs, subagentDir)) ?? [])
      .filter((entry) => entry.isFile)
      .sort(byName);
    const subagents: RawSubagentInput[] = [];
    for (const entry of entries) {
      const agentId = SUBAGENT_FILE.exec(entry.name)?.[1];
      if (agentId === undefined) continue;
      let meta: RawSubagentMeta | null;
      try {
        const parsed: unknown = JSON.parse(
          await fs.readText(p.join(subagentDir, `agent-${agentId}.meta.json`)),
        );
        meta = isMetaObject(parsed) ? parsed : null;
      } catch {
        meta = null;
      }
      subagents.push({ agentId, meta, lines: lazyLines(fs, p.join(subagentDir, entry.name)) });
    }
    return { main: lazyLines(fs, ref.locator), subagents };
  }

  return {
    runtime: CLAUDE_CODE_RUNTIME,
    displayName: "Claude Code",
    resolveRoots,
    listSessions,
    openSession,
  };
}

/** The Claude Code adapter on Node's file system. */
export const claudeCodeAdapter: SourceAdapter = createClaudeCodeAdapter();
