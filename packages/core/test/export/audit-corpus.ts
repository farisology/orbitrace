/**
 * Ticket #23: the synthetic sessions the export privacy audit attacks, and the mutation tools.
 *
 * The sessions are the committed output of the seeded fixtures generator (`fixtures/config`,
 * listed in `fixtures/manifest.json`, all invented). Core cannot depend on
 * `@orbitrace/fixtures` (that package depends on core), so the files are read from the
 * repository directly. Each transcript line is kept as a parsed JSON object, so a test can
 * change one string, or one key, anywhere in it and run the whole pipeline again:
 * `parseSession` -> `buildReplay` -> `exportReplay`, as the host and `orbitrace export` do.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReplay, exportReplay, parseSession, type SessionInput } from "../../src/index.js";

/** Repository root, from this file's place in `packages/core/test/export`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURES = join(ROOT, "fixtures");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** One subagent of a corpus session: its runtime id (from the file name), meta and lines. */
export interface CorpusSubagent {
  agentId: string;
  meta: JsonObject | null;
  lines: JsonObject[];
}

/** One synthetic session, editable. */
export interface CorpusSession {
  name: string;
  main: JsonObject[];
  subagents: CorpusSubagent[];
}

interface ManifestEntry {
  name: string;
  transcript: string;
  subagents: { agentId: string; transcript: string; meta: string }[];
}

function readLines(relative: string): JsonObject[] {
  return readFileSync(join(FIXTURES, relative), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JsonObject);
}

/**
 * Every session of the committed fixture set, in manifest order. Subagents are in file name
 * order, as the Claude Code adapter lists them.
 */
export function loadCorpus(): CorpusSession[] {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as {
    sessions: ManifestEntry[];
  };
  return manifest.sessions.map((entry) => ({
    name: entry.name,
    main: readLines(entry.transcript),
    subagents: [...entry.subagents]
      .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))
      .map((sub) => ({
        agentId: sub.agentId,
        meta: JSON.parse(readFileSync(join(FIXTURES, sub.meta), "utf8")) as JsonObject,
        lines: readLines(sub.transcript),
      })),
  }));
}

/** The golden replay text of a scenario, as committed. */
export function goldenText(name: string): string {
  return readFileSync(join(FIXTURES, "replays", `${name}.replay.json`), "utf8");
}

/** A deep copy, so a mutation never touches the shared corpus. */
export function cloneSession(session: CorpusSession): CorpusSession {
  return structuredClone(session);
}

/** The parser input for a session: each line serialised as Claude Code writes it. */
export function toInput(session: CorpusSession): SessionInput {
  return {
    main: session.main.map((line) => JSON.stringify(line)),
    subagents: session.subagents.map((sub) => ({
      agentId: sub.agentId,
      meta: sub.meta,
      lines: sub.lines.map((line) => JSON.stringify(line)),
    })),
  };
}

/** The bytes `orbitrace export` would write for this session (compact JSON). */
export async function exportSession(session: CorpusSession): Promise<string> {
  return exportReplay(buildReplay(await parseSession(toInput(session)))).data;
}

/**
 * The app's drop-a-file path: the whole main transcript as one string, no subagents
 * (`replayFromTranscript` in packages/app). Export of what the app would draw.
 */
export async function exportDroppedFile(session: CorpusSession): Promise<string> {
  const text = session.main.map((line) => JSON.stringify(line)).join("\n");
  return exportReplay(buildReplay(await parseSession({ main: [text], subagents: [] }))).data;
}

// ---------------------------------------------------------------------------------------
// Positions: every string value and every key of every line and meta file.
// ---------------------------------------------------------------------------------------

/** Where a value sits: which file of the session, and the path inside it. */
export interface Position {
  /** `main`, or the index of the subagent. */
  file: "main" | number;
  /** `line` for a transcript line (with `line` set), `meta` for the meta file, `agentId`. */
  part: "line" | "meta" | "agentId";
  line: number;
  path: (string | number)[];
}

function walkStrings(
  value: Json,
  path: (string | number)[],
  visit: (path: (string | number)[]) => void,
): void {
  if (typeof value === "string") {
    visit(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, [...path, index], visit));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walkStrings(item, [...path, key], visit);
  }
}

function walkKeys(
  value: Json,
  path: (string | number)[],
  visit: (path: (string | number)[]) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, [...path, index], visit));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit([...path, key]);
      walkKeys(item, [...path, key], visit);
    }
  }
}

function eachDocument(
  session: CorpusSession,
  visit: (doc: Json, base: Omit<Position, "path">) => void,
): void {
  session.main.forEach((line, index) => visit(line, { file: "main", part: "line", line: index }));
  session.subagents.forEach((sub, file) => {
    if (sub.meta !== null) visit(sub.meta, { file, part: "meta", line: 0 });
    sub.lines.forEach((line, index) => visit(line, { file, part: "line", line: index }));
  });
}

/** Every string value in the session, plus each subagent's runtime id. */
export function stringPositions(session: CorpusSession): Position[] {
  const positions: Position[] = [];
  eachDocument(session, (doc, base) =>
    walkStrings(doc, [], (path) => positions.push({ ...base, path })),
  );
  session.subagents.forEach((_, file) =>
    positions.push({ file, part: "agentId", line: 0, path: [] }),
  );
  return positions;
}

/** Every key of every object in the session's lines and meta files. */
export function keyPositions(session: CorpusSession): Position[] {
  const positions: Position[] = [];
  eachDocument(session, (doc, base) =>
    walkKeys(doc, [], (path) => positions.push({ ...base, path })),
  );
  return positions;
}

function documentOf(session: CorpusSession, position: Position): Json {
  const run = position.file === "main" ? null : session.subagents[position.file];
  if (position.part === "meta") return run?.meta ?? null;
  const lines = run === null ? session.main : (run?.lines ?? []);
  return lines[position.line] ?? null;
}

function parentOf(doc: Json, path: readonly (string | number)[]): Json {
  let node = doc;
  for (const step of path.slice(0, -1)) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string | number, Json>)[step] ?? null;
  }
  return node;
}

/** The string at a position (the runtime id for `agentId`). */
export function readString(session: CorpusSession, position: Position): string {
  if (position.part === "agentId") {
    return session.subagents[position.file as number]?.agentId ?? "";
  }
  const parent = parentOf(documentOf(session, position), position.path);
  const last = position.path[position.path.length - 1] as string | number;
  return String((parent as Record<string | number, Json>)[last]);
}

/**
 * Runs one mutation at a time on a session without copying it: each line is serialised once,
 * a mutation changes one document in place, only that document is serialised again, and the
 * change is undone afterwards. Thousands of single-position runs stay within a few seconds.
 */
export class SingleMutationRunner {
  private readonly mainText: string[];
  private readonly subText: string[][];

  constructor(private readonly session: CorpusSession) {
    this.mainText = session.main.map((line) => JSON.stringify(line));
    this.subText = session.subagents.map((sub) => sub.lines.map((line) => JSON.stringify(line)));
  }

  /**
   * Apply `mutate` (which changes the document at `position` in place and returns an undo
   * function), export, undo, and return the export or the error text.
   */
  async run(
    position: Position,
    mutate: () => () => void,
  ): Promise<{ readonly data?: string; readonly error?: string }> {
    const undo = mutate();
    try {
      const input = this.input(position);
      return { data: exportReplay(buildReplay(await parseSession(input))).data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      undo();
    }
  }

  private input(position: Position): SessionInput {
    const { session } = this;
    const changed =
      position.part === "line" ? JSON.stringify(documentOf(session, position)) : undefined;
    const main =
      position.file === "main" && changed !== undefined
        ? this.mainText.map((text, index) => (index === position.line ? changed : text))
        : this.mainText;
    return {
      main,
      subagents: session.subagents.map((sub, file) => {
        const own = this.subText[file] as string[];
        return {
          agentId: sub.agentId,
          meta: sub.meta,
          lines:
            position.file === file && changed !== undefined
              ? own.map((text, index) => (index === position.line ? changed : text))
              : own,
        };
      }),
    };
  }

  /** Replace one string, export, restore. */
  replaceString(position: Position, value: string): Promise<{ data?: string; error?: string }> {
    return this.run(position, () => {
      const old = readString(this.session, position);
      writeString(this.session, position, value);
      return () => writeString(this.session, position, old);
    });
  }

  /** Rename one key, export, restore. */
  replaceKey(position: Position, name: string): Promise<{ data?: string; error?: string }> {
    return this.run(position, () => {
      const old = position.path[position.path.length - 1] as string;
      renameKey(this.session, position, name);
      const renamed = [...position.path.slice(0, -1), name];
      return () => renameKey(this.session, { ...position, path: renamed }, old);
    });
  }
}

/** Replace the string at a position, in place. */
export function writeString(session: CorpusSession, position: Position, value: string): void {
  if (position.part === "agentId") {
    (session.subagents[position.file as number] as CorpusSubagent).agentId = value;
    return;
  }
  const parent = parentOf(documentOf(session, position), position.path);
  const last = position.path[position.path.length - 1] as string | number;
  (parent as Record<string | number, Json>)[last] = value;
}

/** Rename the key at a position, in place, keeping its value and the other keys' order. */
export function renameKey(session: CorpusSession, position: Position, name: string): void {
  const parent = parentOf(documentOf(session, position), position.path) as JsonObject;
  const old = position.path[position.path.length - 1] as string;
  const entries = Object.entries(parent).map(([key, value]): [string, Json] =>
    key === old ? [name, value] : [key, value],
  );
  for (const key of Object.keys(parent)) delete parent[key];
  for (const [key, value] of entries) parent[key] = value;
}

/** Add `name: value` to every object at every depth of every line and meta file, in place. */
export function plantEverywhere(session: CorpusSession, name: string, value: string): void {
  const plant = (node: Json): void => {
    if (Array.isArray(node)) node.forEach(plant);
    else if (node !== null && typeof node === "object") {
      for (const item of Object.values(node)) plant(item);
      node[name] = value;
    }
  };
  eachDocument(session, (doc) => plant(doc));
}

// ---------------------------------------------------------------------------------------
// What each position is, for the expected outcome of a mutation.
// ---------------------------------------------------------------------------------------

/**
 * How a string position can affect the export.
 *
 * - `name`: written to the export as it is when it is an identifier (agent type, model id,
 *   tool name). The documented exception.
 * - `id`: links parts of the session (session id, line and message ids, tool use ids, the
 *   meta `toolUseId`, the runtime agent id). Only equality matters, never the value.
 * - `structure`: decides how a line is read (line type, content block type, timestamp,
 *   effort). The export changes, but the value itself is never written.
 * - `content`: everything else. Must not change a single byte of the export.
 */
export type PositionKind = "name" | "id" | "structure" | "content";

const ID_KEYS = new Set(["sessionId", "uuid", "parentUuid", "tool_use_id", "toolUseId"]);

/** The kind of a string position, from its path and the line it is in. */
export function kindOf(session: CorpusSession, position: Position): PositionKind {
  if (position.part === "agentId") return "id";
  const path = position.path;
  const last = path[path.length - 1];
  if (position.part === "meta") {
    if (path.length !== 1) return "content";
    if (last === "agentType" || last === "model") return "name";
    if (last === "toolUseId") return "id";
    return "content";
  }
  const line = documentOf(session, position) as JsonObject;
  const type = line["type"];
  if (path.length === 1) {
    if (last === "type" || last === "timestamp") return "structure";
    if (last === "effort" && type === "assistant") return "structure";
    if (typeof last === "string" && ID_KEYS.has(last)) return "id";
    return "content";
  }
  if (path[0] !== "message" || (type !== "assistant" && type !== "user")) return "content";
  if (path.length === 2) {
    if (type === "assistant" && last === "model") return "name";
    if (type === "assistant" && last === "id") return "id";
    return "content";
  }
  // message.content[i].<key>
  if (path.length === 4 && path[1] === "content" && typeof path[2] === "number") {
    const block = parentOf(line, path) as JsonObject;
    if (last === "type") return "structure";
    if (type === "assistant" && block["type"] === "tool_use") {
      if (last === "name") return "name";
      if (last === "id") return "id";
    }
    if (type === "user" && block["type"] === "tool_result" && last === "tool_use_id") return "id";
  }
  return "content";
}
