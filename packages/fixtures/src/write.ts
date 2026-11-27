/**
 * Writes the generated fixture files to a folder, and checks a folder against the generator.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_FOLDER,
  MANIFEST_FILE,
  renderFixtureTree,
  type BuiltSession,
  type GenerateOptions,
} from "./generator.js";

export interface FixtureTreeDiff {
  /** Generated files that are not on disk. */
  missing: string[];
  /** Files on disk whose bytes differ from the generator's. */
  changed: string[];
  /** Files on disk, in the generated part of the folder, that the generator does not write. */
  extra: string[];
}

function toDiskPath(fixturesDir: string, relative: string): string {
  return join(fixturesDir, ...relative.split("/"));
}

/**
 * Every file below `dir` as `prefix/<path>` with forward slashes, the entries of each folder
 * in name order. Empty when the folder does not exist.
 */
export function listFiles(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

/**
 * Write the manifest and the config folder into `fixturesDir`. The config folder is
 * replaced as a whole, so files of an older seed do not linger. Other files in
 * `fixturesDir`, such as its README, are left alone. Returns the relative paths written.
 */
export function writeFixtureTree(fixturesDir: string, options: GenerateOptions = {}): string[] {
  const files = renderFixtureTree(options);
  rmSync(join(fixturesDir, CONFIG_FOLDER), { recursive: true, force: true });
  for (const file of files) {
    const target = toDiskPath(fixturesDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  return files.map((file) => file.path);
}

/** Compare `fixturesDir` with what the generator writes, byte for byte. */
export function checkFixtureTree(
  fixturesDir: string,
  options: GenerateOptions = {},
): FixtureTreeDiff {
  const files = renderFixtureTree(options);
  const expected = new Set(files.map((file) => file.path));
  const diff: FixtureTreeDiff = { missing: [], changed: [], extra: [] };
  for (const file of files) {
    const target = toDiskPath(fixturesDir, file.path);
    if (!existsSync(target)) diff.missing.push(file.path);
    else if (!readFileSync(target).equals(Buffer.from(file.content, "utf8"))) {
      diff.changed.push(file.path);
    }
  }
  for (const path of listFiles(join(fixturesDir, CONFIG_FOLDER), CONFIG_FOLDER)) {
    if (!expected.has(path)) diff.extra.push(path);
  }
  if (!expected.has(MANIFEST_FILE)) throw new Error("the generator did not write a manifest");
  return diff;
}

/** True when the folder holds exactly what the generator writes. */
export function isFixtureTreeCurrent(diff: FixtureTreeDiff): boolean {
  return diff.missing.length === 0 && diff.changed.length === 0 && diff.extra.length === 0;
}

/**
 * #191. Write the files of one generated session (for example an on-demand scenario from
 * `generateExtraSession`) into `configDir`, a folder laid out like a Claude Code config folder,
 * which must be a temporary or synthetic one. Existing files are overwritten; nothing else is
 * removed. Returns the absolute paths written.
 */
export function writeGeneratedSession(configDir: string, session: BuiltSession): string[] {
  const written: string[] = [];
  for (const file of session.files) {
    const target = toDiskPath(configDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
    written.push(target);
  }
  return written;
}
