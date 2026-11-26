/// <reference types="node" />
// In-memory SourceFileSystem for tests. Paths use one OS's rules (posix or win32), so the
// adapter can be run against a fake Windows tree on a macOS or Linux host. Every value in
// these trees is invented.
import path from "node:path";
import type {
  SourceDirEntry,
  SourceFileSystem,
  SourceFileStat,
} from "../../../src/sources/node.js";

type Flavour = "posix" | "win32";

interface MemFile {
  text: string;
  mtimeMs: number;
}

export interface MemFs extends SourceFileSystem {
  /** Add a file; parent folders are created. */
  file(filePath: string, text: string, mtimeMs?: number): MemFs;
  /** Add an empty folder; parent folders are created. */
  dir(dirPath: string): MemFs;
  /** Make a folder unreadable (readDir rejects). */
  deny(dirPath: string): MemFs;
  /** Paths passed to readLines, in call order. */
  readonly linesOpened: string[];
}

export function createMemFs(flavour: Flavour): MemFs {
  const p = flavour === "win32" ? path.win32 : path.posix;
  const key = (value: string): string => {
    let normalized = p.normalize(value);
    const { root } = p.parse(normalized);
    while (normalized.length > root.length && normalized.endsWith(p.sep))
      normalized = normalized.slice(0, -1);
    return flavour === "win32" ? normalized.toLowerCase() : normalized;
  };
  const files = new Map<string, MemFile>();
  const dirs = new Map<string, string>(); // key -> display path
  const denied = new Set<string>();
  const linesOpened: string[] = [];

  const addDir = (dirPath: string): void => {
    let current = p.normalize(dirPath);
    for (;;) {
      dirs.set(key(current), current);
      const parent = p.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  const missing = (what: string): Error =>
    Object.assign(new Error(`ENOENT: ${what}`), { code: "ENOENT" });

  const fs: MemFs = {
    linesOpened,
    file(filePath, text, mtimeMs = 1_000) {
      addDir(p.dirname(filePath));
      files.set(key(filePath), { text, mtimeMs });
      return fs;
    },
    dir(dirPath) {
      addDir(dirPath);
      return fs;
    },
    deny(dirPath) {
      denied.add(key(dirPath));
      return fs;
    },
    async readDir(dirPath) {
      const k = key(dirPath);
      if (!dirs.has(k) || denied.has(k)) throw missing("folder");
      const entries = new Map<string, SourceDirEntry>();
      for (const [childKey, display] of dirs) {
        if (childKey !== k && key(p.dirname(display)) === k) {
          const name = p.basename(display);
          entries.set(name, { name, isFile: false, isDirectory: true });
        }
      }
      for (const fileKey of files.keys()) {
        if (key(p.dirname(fileKey)) === k) {
          const name = p.basename(fileKey);
          entries.set(name, { name, isFile: true, isDirectory: false });
        }
      }
      return [...entries.values()];
    },
    async stat(target) {
      const k = key(target);
      const found = files.get(k);
      if (found !== undefined)
        return {
          isFile: true,
          isDirectory: false,
          mtimeMs: found.mtimeMs,
        } satisfies SourceFileStat;
      if (dirs.has(k)) return { isFile: false, isDirectory: true, mtimeMs: 0 };
      throw missing("path");
    },
    async readText(target) {
      const found = files.get(key(target));
      if (found === undefined) throw missing("file");
      return found.text;
    },
    async readHead(target, maxBytes) {
      const found = files.get(key(target));
      if (found === undefined) throw missing("file");
      return found.text.slice(0, maxBytes);
    },
    readLines(target) {
      return {
        async *[Symbol.asyncIterator]() {
          linesOpened.push(target);
          const found = files.get(key(target));
          if (found === undefined) throw missing("file");
          const lines = found.text.split(/\r?\n/);
          if (lines[lines.length - 1] === "") lines.pop();
          yield* lines;
        },
      };
    },
    async realPath(target) {
      const k = key(target);
      if (!dirs.has(k) && !files.has(k)) throw missing("path");
      return dirs.get(k) ?? target;
    },
  };
  return fs;
}

/** Collect a LineSource into an array. */
export async function collect(source: Iterable<string> | AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}

/** One synthetic transcript line with an invented working directory. */
export function lineWithCwd(cwd: string): string {
  return JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", cwd });
}
