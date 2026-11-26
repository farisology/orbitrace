/**
 * Golden replay files: what the replay pipeline of `@orbitrace/core` makes of each fixture
 * session, committed under `fixtures/replays/` so that a change in the pipeline's output is
 * seen in review.
 *
 * This module holds no parser and no replay builder. Every golden is the output of the real
 * pipeline, in this order:
 *
 *   Claude Code adapter `listSessions` and `openSession` (from `@orbitrace/core/node`)
 *   -> `parseSession` -> `buildReplay` -> `validateReplay` -> `exportReplay`
 *
 * The adapter is only ever pointed at the synthetic config folder of the fixtures. Root
 * resolution (`resolveRoots`, `resolveSources`) is not used on purpose: it would also find
 * the config folder of the person running the command, and a golden must never be made from
 * a real session.
 *
 * A golden is never edited by hand. To change one, change the pipeline or the generator and
 * run `npm run goldens -w @orbitrace/fixtures`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FORBIDDEN_REPLAY_KEYS,
  buildReplay,
  describeReplayProblems,
  exportReplay,
  parseSession,
  validateReplay,
  type ReplayModel,
  type SessionRef,
  type SourceRoot,
} from "@orbitrace/core";
import { claudeCodeAdapter } from "@orbitrace/core/node";
import {
  CONFIG_FOLDER,
  HAND_WRITTEN_REPLAYS,
  MANIFEST_FILE,
  MANIFEST_VERSION,
  REPLAYS_FOLDER,
  REPLAY_FILE_SUFFIX,
  type FixtureManifest,
  type GeneratedFile,
  type ScenarioName,
} from "./generator.js";
import { describeJsonDifferences, findKeys } from "./json.js";
import { FIXTURES_DIR } from "./paths.js";
import { listFiles } from "./write.js";

const GENERATE_HINT = "Run: npm run generate -w @orbitrace/fixtures";

/** The command that rewrites the goldens, for messages. */
export const GOLDENS_COMMAND = "npm run goldens -w @orbitrace/fixtures";

/**
 * What a golden replay path in the manifest must look like: a file directly in the replays
 * folder, named with lower-case letters, digits and dashes. Anything else is refused before a
 * file is written, so a wrong manifest cannot make this module write outside that folder.
 */
const GOLDEN_FILE = /^replays\/[a-z0-9][a-z0-9-]*\.replay\.json$/;

/** One golden replay: the file, and the model it was written from. */
export interface GoldenReplayFile extends GeneratedFile {
  /** The scenario the golden belongs to. */
  name: ScenarioName;
  /** What `buildReplay` returned. `content` is `exportReplay` of it, indented. */
  model: ReplayModel;
}

export interface GoldenReplayChange {
  /** Path relative to the fixtures folder, with forward slashes. */
  path: string;
  /** Readable lines saying where the committed file and the regenerated one differ. */
  differences: string[];
}

export interface GoldenReplayDiff {
  /** Goldens the manifest lists that are not on disk. */
  missing: string[];
  /** Goldens on disk whose bytes differ from what the pipeline writes. */
  changed: GoldenReplayChange[];
  /**
   * Replay files in the replays folder that are neither a listed golden nor a hand-written
   * example, for example the golden of a scenario that was renamed. Delete them by hand.
   */
  extra: string[];
}

function toDiskPath(fixturesDir: string, relative: string): string {
  return join(fixturesDir, ...relative.split("/"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `manifest.json` of a fixtures folder and check the parts the golden code relies on:
 * the manifest version, a name, a session id and a golden replay path for every session, and
 * a `goldenReplays` list that names exactly those paths. Throws with the reason otherwise.
 * The `expected` blocks are returned as they are, unchecked.
 */
export function readFixtureManifest(fixturesDir: string = FIXTURES_DIR): FixtureManifest {
  const file = join(fixturesDir, MANIFEST_FILE);
  if (!existsSync(file)) throw new Error(`${MANIFEST_FILE} not found. ${GENERATE_HINT}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${MANIFEST_FILE} is not valid JSON. ${GENERATE_HINT}`);
  }
  if (!isRecord(parsed) || parsed.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(
      `${MANIFEST_FILE} is not a version ${MANIFEST_VERSION} fixture manifest. ${GENERATE_HINT}`,
    );
  }
  const { sessions, goldenReplays } = parsed;
  if (!Array.isArray(sessions) || !Array.isArray(goldenReplays)) {
    throw new Error(`${MANIFEST_FILE} has no sessions or no goldenReplays list. ${GENERATE_HINT}`);
  }
  const listed: string[] = [];
  sessions.forEach((session: unknown, index) => {
    if (
      !isRecord(session) ||
      typeof session.name !== "string" ||
      typeof session.sessionId !== "string" ||
      typeof session.goldenReplay !== "string"
    ) {
      throw new Error(
        `${MANIFEST_FILE}: session ${index} lacks a name, a sessionId or a goldenReplay. ${GENERATE_HINT}`,
      );
    }
    const golden = session.goldenReplay;
    if (!GOLDEN_FILE.test(golden) || HAND_WRITTEN_REPLAYS.includes(golden)) {
      throw new Error(
        `${MANIFEST_FILE}: session "${session.name}" names a golden replay that is not a file of its own in ${REPLAYS_FOLDER}/. ${GENERATE_HINT}`,
      );
    }
    if (listed.includes(golden)) {
      throw new Error(
        `${MANIFEST_FILE}: two sessions name the same golden replay (${golden}). ${GENERATE_HINT}`,
      );
    }
    listed.push(golden);
  });
  if (
    goldenReplays.length !== listed.length ||
    goldenReplays.some((path, index) => path !== listed[index])
  ) {
    throw new Error(
      `${MANIFEST_FILE}: goldenReplays does not list the golden replay of each session, in order. ${GENERATE_HINT}`,
    );
  }
  return parsed as unknown as FixtureManifest;
}

/**
 * The synthetic config folder of a fixtures folder as a source root, built directly so that
 * no other folder is ever looked at.
 */
function fixtureRoot(fixturesDir: string): SourceRoot {
  return {
    runtime: claudeCodeAdapter.runtime,
    root: join(fixturesDir, CONFIG_FOLDER),
    resolvedBy: "user-setting",
    available: true,
  };
}

/**
 * Refuse a value that may not be committed as a golden: one that holds a key the contract
 * forbids in a replay, at any depth, or that is not a valid replay v1. `label` names the
 * session in the error. The forbidden keys are checked by name first; the schema rejects them
 * too, and this check stays true if the schema is ever loosened.
 */
export function assertGoldenReplay(value: unknown, label: string): asserts value is ReplayModel {
  const forbidden = findKeys(value, FORBIDDEN_REPLAY_KEYS);
  if (forbidden.length > 0) {
    throw new Error(`${label}: the replay holds a forbidden key at ${forbidden.join(", ")}`);
  }
  if (!validateReplay(value)) {
    throw new Error(
      `${label}: the replay is not a valid replay v1:\n- ${describeReplayProblems(value).join("\n- ")}`,
    );
  }
}

/** Run one session through the pipeline. `label` names the session in an error. */
async function runPipeline(
  ref: SessionRef,
  label: string,
): Promise<{ model: ReplayModel; content: string }> {
  const input = await claudeCodeAdapter.openSession(ref);
  const parsed = await parseSession(input);
  const model: ReplayModel = buildReplay(parsed);
  assertGoldenReplay(model, label);
  // Indented, so a change shows up in review as the few lines that changed.
  return { model, content: exportReplay(model, { pretty: true }).data };
}

/**
 * Build the golden replay of every session in the manifest of `fixturesDir`, in manifest
 * order, from the transcripts in its config folder. Nothing is written. Throws when a
 * session of the manifest is not on disk, or when a built replay is not a valid replay v1.
 *
 * The same folder always gives the same bytes: the pipeline reads no clock, and the time of
 * a file's last change is used only to list sessions, never in a replay.
 */
export async function renderGoldenReplays(
  fixturesDir: string = FIXTURES_DIR,
): Promise<GoldenReplayFile[]> {
  const manifest = readFixtureManifest(fixturesDir);
  const refs = await claudeCodeAdapter.listSessions(fixtureRoot(fixturesDir));
  const files: GoldenReplayFile[] = [];
  for (const session of manifest.sessions) {
    const label = `session "${session.name}"`;
    const found = refs.filter((ref) => ref.sessionId === session.sessionId);
    const [ref] = found;
    if (ref === undefined || found.length > 1) {
      throw new Error(
        `${label}: the source adapter found ${found.length} transcripts for it in ${CONFIG_FOLDER}/, expected 1. ${GENERATE_HINT}`,
      );
    }
    files.push({
      name: session.name,
      path: session.goldenReplay,
      ...(await runPipeline(ref, label)),
    });
  }
  return files;
}

/**
 * Write the golden replay of every session into the replays folder of `fixturesDir`. Every
 * replay is built first, so a failure writes nothing. Other files in the folder are left
 * alone. Returns the relative paths written.
 */
export async function writeGoldenReplays(fixturesDir: string = FIXTURES_DIR): Promise<string[]> {
  const files = await renderGoldenReplays(fixturesDir);
  for (const file of files) {
    const target = toDiskPath(fixturesDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  return files.map((file) => file.path);
}

/** 1-based number of the first line on which two texts differ. */
function firstDifferentLine(a: string, b: string): number {
  const left = a.split("\n");
  const right = b.split("\n");
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index + 1;
}

/**
 * Readable lines saying how the text of a committed golden differs from the regenerated
 * text. Empty when the bytes are the same. Differences in the data are listed by place (see
 * `describeJsonDifferences`); a file that holds the same data in other bytes says so.
 */
export function describeGoldenChange(
  committed: string,
  regenerated: string,
  limit?: number,
): string[] {
  if (committed === regenerated) return [];
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(committed);
  } catch {
    return ["the committed file is not valid JSON"];
  }
  try {
    after = JSON.parse(regenerated);
  } catch {
    return ["the regenerated text is not valid JSON"];
  }
  const differences = describeJsonDifferences(before, after, limit);
  if (differences.length > 0) return differences;
  return [
    `same data, different bytes (key order, indentation or line endings), first at line ${firstDifferentLine(committed, regenerated)}`,
  ];
}

/**
 * Compare the replays folder of `fixturesDir` with what the pipeline writes, byte for byte.
 * Nothing is written.
 */
export async function checkGoldenReplays(
  fixturesDir: string = FIXTURES_DIR,
): Promise<GoldenReplayDiff> {
  const files = await renderGoldenReplays(fixturesDir);
  const diff: GoldenReplayDiff = { missing: [], changed: [], extra: [] };
  for (const file of files) {
    const target = toDiskPath(fixturesDir, file.path);
    if (!existsSync(target)) {
      diff.missing.push(file.path);
      continue;
    }
    const differences = describeGoldenChange(readFileSync(target, "utf8"), file.content);
    if (differences.length > 0) diff.changed.push({ path: file.path, differences });
  }
  const known = new Set([...files.map((file) => file.path), ...HAND_WRITTEN_REPLAYS]);
  for (const path of listFiles(join(fixturesDir, REPLAYS_FOLDER), REPLAYS_FOLDER)) {
    if (path.endsWith(REPLAY_FILE_SUFFIX) && !known.has(path)) diff.extra.push(path);
  }
  return diff;
}

/** True when the replays folder holds exactly the goldens the pipeline writes. */
export function isGoldenReplaysCurrent(diff: GoldenReplayDiff): boolean {
  return diff.missing.length === 0 && diff.changed.length === 0 && diff.extra.length === 0;
}

/**
 * A diff as lines for a person: one line per file, and under a changed file its differences,
 * indented. Empty when nothing differs.
 */
export function describeGoldenReplayDiff(diff: GoldenReplayDiff): string[] {
  const lines: string[] = [];
  for (const path of diff.missing) lines.push(`missing: ${path}`);
  for (const change of diff.changed) {
    lines.push(`changed: ${change.path}`);
    for (const difference of change.differences) lines.push(`  ${difference}`);
  }
  for (const path of diff.extra) lines.push(`not a golden: ${path}`);
  return lines;
}
