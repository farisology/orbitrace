/// <reference types="node" />
/**
 * The file access a source adapter needs, as an interface, so the adapter can run against a
 * fake file system in tests (including Windows paths on a macOS or Linux host) and against
 * another host's file API later. `createNodeFileSystem` is the real one.
 *
 * Node only. Exported from `@orbitrace/core/node`.
 */

import { createReadStream } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface SourceDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface SourceFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** Last modification, Unix epoch milliseconds. */
  readonly mtimeMs: number;
}

/** Every method rejects when the path is missing or unreadable. */
export interface SourceFileSystem {
  /** Entries of a folder. Symbolic links are reported as what they point to. */
  readDir(path: string): Promise<readonly SourceDirEntry[]>;
  stat(path: string): Promise<SourceFileStat>;
  /** Whole file as UTF-8. */
  readText(path: string): Promise<string>;
  /** At most `maxBytes` from the start of a file, as UTF-8. */
  readHead(path: string, maxBytes: number): Promise<string>;
  /** Lines in file order, without line endings (`\n` or `\r\n`). Opens the file when iterated. */
  readLines(path: string): AsyncIterable<string>;
  /** Canonical path with symbolic links resolved. */
  realPath(path: string): Promise<string>;
}

/** A `SourceFileSystem` on Node's file APIs. Reads only; never writes. */
export function createNodeFileSystem(): SourceFileSystem {
  return {
    async readDir(dirPath) {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const result: SourceDirEntry[] = [];
      for (const entry of entries) {
        let isFile = entry.isFile();
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const target = await stat(join(dirPath, entry.name));
            isFile = target.isFile();
            isDirectory = target.isDirectory();
          } catch {
            // A broken link is neither a file nor a folder.
          }
        }
        result.push({ name: entry.name, isFile, isDirectory });
      }
      return result;
    },
    async stat(filePath) {
      const info = await stat(filePath);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs };
    },
    readText(filePath) {
      return readFile(filePath, "utf8");
    },
    async readHead(filePath, maxBytes) {
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, Math.floor(maxBytes)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    },
    readLines(filePath) {
      return {
        async *[Symbol.asyncIterator]() {
          const stream = createReadStream(filePath, { encoding: "utf8" });
          const lines = createInterface({ input: stream, crlfDelay: Infinity });
          try {
            for await (const line of lines) yield line;
          } finally {
            lines.close();
            stream.destroy();
          }
        },
      };
    },
    realPath(filePath) {
      return realpath(filePath);
    },
  };
}
