/**
 * Ticket #23: privacy audit of the export path, as tests.
 *
 * Attacks `parseSession` -> `buildReplay` -> `exportReplay` with invented marker strings
 * (audit-markers.ts) planted in every string and every key of the synthetic fixture sessions
 * (audit-corpus.ts), one position at a time, and checks the exported bytes. The findings and
 * the field table are in docs/security/export-audit.md.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  cloneSession,
  exportDroppedFile,
  exportSession,
  goldenText,
  keyPositions,
  kindOf,
  loadCorpus,
  plantEverywhere,
  readString,
  stringPositions,
  writeString,
  type CorpusSession,
  type JsonObject,
  type Position,
  SingleMutationRunner,
} from "./audit-corpus.js";
import {
  ALL_MARKERS,
  FREE_TEXT_MARKERS,
  IDENTIFIER_MARKERS,
  NAME_POINTERS,
  hasMarker,
  markerPointers,
} from "./audit-markers.js";

const corpus = loadCorpus();
const baselines = new Map<string, string>();

beforeAll(async () => {
  for (const session of corpus) baselines.set(session.name, await exportSession(session));
});

function baseline(session: CorpusSession): string {
  return baselines.get(session.name) as string;
}

function describePosition(session: CorpusSession, position: Position): string {
  return `${session.name} ${String(position.file)} ${position.part} ${position.line} /${position.path.join("/")}`;
}

describe("the audit corpus", () => {
  it("covers every scenario and matches the committed goldens", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(9);
    for (const session of corpus) {
      expect({ session: session.name, replay: JSON.parse(baseline(session)) as unknown }).toEqual({
        session: session.name,
        replay: JSON.parse(goldenText(session.name)) as unknown,
      });
      expect(hasMarker(baseline(session))).toBe(false);
    }
  });

  it("has subagents, MCP calls, failures and unknown lines to attack", () => {
    const all = corpus.flatMap((session) => stringPositions(session).map((p) => [session, p]));
    const kinds = new Set(all.map(([s, p]) => kindOf(s as CorpusSession, p as Position)));
    expect([...kinds].sort()).toEqual(["content", "id", "name", "structure"]);
    const names = all
      .filter(([s, p]) => kindOf(s as CorpusSession, p as Position) === "name")
      .map(([s, p]) => readString(s as CorpusSession, p as Position));
    expect(names.some((name) => name.startsWith("mcp__"))).toBe(true);
    expect(corpus.some((session) => session.subagents.length > 0)).toBe(true);
  });
});

describe("content never changes the export", () => {
  it("gives the same bytes when every content string is replaced by free text", async () => {
    for (const session of corpus) {
      const copy = cloneSession(session);
      const positions = stringPositions(copy).filter((p) => kindOf(copy, p) === "content");
      expect(positions.length).toBeGreaterThan(0);
      positions.forEach((position, index) => {
        writeString(copy, position, ALL_MARKERS[index % ALL_MARKERS.length] as string);
      });
      expect({ session: session.name, data: await exportSession(copy) }).toEqual({
        session: session.name,
        data: baseline(session),
      });
    }
  });

  it("gives the same bytes when a marker key is added to every object at every depth", async () => {
    for (const session of corpus) {
      const copy = cloneSession(session);
      plantEverywhere(copy, FREE_TEXT_MARKERS[0] as string, FREE_TEXT_MARKERS[1] as string);
      plantEverywhere(copy, IDENTIFIER_MARKERS[1] as string, IDENTIFIER_MARKERS[0] as string);
      expect({ session: session.name, data: await exportSession(copy) }).toEqual({
        session: session.name,
        data: baseline(session),
      });
    }
  });

  it("gives the same bytes when every id is renamed consistently (ids are never copied)", async () => {
    for (const session of corpus) {
      const copy = cloneSession(session);
      const renamed = new Map<string, string>();
      const rename = (value: string): string => {
        let next = renamed.get(value);
        if (next === undefined) {
          const marker = ALL_MARKERS[renamed.size % ALL_MARKERS.length] as string;
          next = `${marker} #${renamed.size}`;
          renamed.set(value, next);
        }
        return next;
      };
      for (const position of stringPositions(copy)) {
        if (kindOf(copy, position) === "id") {
          writeString(copy, position, rename(readString(copy, position)));
        }
      }
      expect({ session: session.name, data: await exportSession(copy) }).toEqual({
        session: session.name,
        data: baseline(session),
      });
    }
  });

  it("gives the same bytes when every timestamp is moved by the same amount (no wall clock)", async () => {
    const shift = 987 * 86_400_000 + 4_321;
    for (const session of corpus) {
      const copy = cloneSession(session);
      for (const position of stringPositions(copy)) {
        if (position.path.length !== 1 || position.path[0] !== "timestamp") continue;
        const ms = Date.parse(readString(copy, position));
        if (Number.isFinite(ms)) writeString(copy, position, new Date(ms + shift).toISOString());
      }
      expect({ session: session.name, data: await exportSession(copy) }).toEqual({
        session: session.name,
        data: baseline(session),
      });
    }
  });
});

/**
 * Single-position runs use every scenario but `demo`: `demo` is made by the same generator from
 * the same line shapes and is about as large as all the others together, so it would add
 * minutes, not coverage. It is in every batch test above and below.
 */
const singleRunCorpus = corpus.filter((session) => session.name !== "demo");

/**
 * Keys outside free content: the top level of a line or meta file, `message.*`, `message.usage.*`
 * and `message.content[i].*`. Keys deeper inside content (tool inputs, results, snapshots) are
 * covered by the planted-key batch test.
 */
function isStructuralKey(position: Position): boolean {
  const path = position.path;
  if (path.length === 1) return true;
  if (path[0] !== "message") return false;
  if (path.length === 2) return true;
  if (path.length === 3) return path[1] === "usage";
  return path.length === 4 && path[1] === "content" && typeof path[2] === "number";
}

describe("one planted value at a time", () => {
  it("puts every marker in every content string of every scenario without changing a byte", async () => {
    // Batched: content strings do not interact, and the single test above shows that all of
    // them together change nothing. Here each one gets each marker in turn.
    for (const session of corpus) {
      for (const [round, marker] of ALL_MARKERS.entries()) {
        const copy = cloneSession(session);
        const positions = stringPositions(copy).filter((p) => kindOf(copy, p) === "content");
        positions.forEach((position, index) => {
          const shifted = ALL_MARKERS[(index + round) % ALL_MARKERS.length] as string;
          writeString(copy, position, round === 0 ? marker : shifted);
        });
        expect({ session: session.name, round, data: await exportSession(copy) }).toEqual({
          session: session.name,
          round,
          data: baseline(session),
        });
      }
    }
  });

  it(
    "never lets free text through an id, structure or name position, and lets an identifier through only as a name",
    { timeout: 60_000 },
    async () => {
      let checked = 0;
      const failures: string[] = [];
      for (const session of singleRunCorpus) {
        const runner = new SingleMutationRunner(session);
        const positions = stringPositions(session).filter((p) => kindOf(session, p) !== "content");
        for (const [index, position] of positions.entries()) {
          const kind = kindOf(session, position);
          const free = FREE_TEXT_MARKERS[index % FREE_TEXT_MARKERS.length] as string;
          const ident = IDENTIFIER_MARKERS[index % IDENTIFIER_MARKERS.length] as string;
          for (const marker of [free, ident]) {
            const result = await runner.replaceString(position, marker);
            checked += 1;
            const where = describePosition(session, position);
            if (result.error !== undefined) {
              failures.push(`${where}: export threw`);
              if (hasMarker(result.error)) failures.push(`${where}: error quotes the marker`);
              continue;
            }
            const leaks = markerPointers(JSON.parse(result.data as string));
            const allowed = kind === "name" && marker === ident;
            const bad = allowed ? leaks.filter((p) => !NAME_POINTERS.test(p)) : leaks;
            if (bad.length > 0) failures.push(`${where} (${kind}): marker at ${bad.join(", ")}`);
          }
        }
      }
      expect(failures).toEqual([]);
      expect(checked).toBeGreaterThan(4000);
    },
  );

  it("never lets a renamed key through", { timeout: 60_000 }, async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const session of singleRunCorpus) {
      const runner = new SingleMutationRunner(session);
      const positions = keyPositions(session).filter(isStructuralKey);
      for (const [index, position] of positions.entries()) {
        const result = await runner.replaceKey(
          position,
          ALL_MARKERS[index % ALL_MARKERS.length] as string,
        );
        checked += 1;
        if (hasMarker(result.data ?? result.error ?? "")) {
          failures.push(describePosition(session, position));
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(3000);
  });

  it("restores the session after each single run", async () => {
    for (const session of singleRunCorpus) {
      expect(await exportSession(session)).toBe(baseline(session));
    }
  });
});

describe("names exported as written (the documented exception)", () => {
  function firstPosition(
    predicate: (session: CorpusSession, position: Position) => boolean,
  ): [CorpusSession, Position] {
    for (const session of corpus) {
      for (const position of stringPositions(session)) {
        if (predicate(session, position)) return [session, position];
      }
    }
    throw new Error("no such position in the corpus");
  }

  const metaKey = (key: string) => (_: CorpusSession, p: Position) =>
    p.part === "meta" && p.path.length === 1 && p.path[0] === key;

  it("keeps an identifier-shaped agent type, so a client or project name used as one is exported", async () => {
    const [session, position] = firstPosition(metaKey("agentType"));
    const copy = cloneSession(session);
    writeString(copy, position, "zqx-client-rollout");
    const pointers = markerPointers(JSON.parse(await exportSession(copy)));
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.every((p) => /^\/agents\/\d+\/(name|callsign)$/.test(p))).toBe(true);
  });

  it("replaces an agent type that is not an identifier whole (finding F1, fixed)", async () => {
    const [session, position] = firstPosition(metaKey("agentType"));
    for (const marker of FREE_TEXT_MARKERS) {
      const copy = cloneSession(session);
      writeString(copy, position, marker);
      const data = await exportSession(copy);
      expect(hasMarker(data)).toBe(false);
      expect(data).toContain('"name":"subagent"');
    }
  });

  it("keeps an identifier-shaped MCP server name as mcp:<server> and never the MCP tool name", async () => {
    const [session, position] = firstPosition(
      (s, p) => kindOf(s, p) === "name" && readString(s, p).startsWith("mcp__"),
    );
    const server = cloneSession(session);
    writeString(server, position, "mcp__zqx-client-rollout__lookup");
    expect(markerPointers(JSON.parse(await exportSession(server)))).not.toEqual([]);
    expect(await exportSession(server)).toContain('"mcp:zqx-client-rollout"');

    for (const marker of [...FREE_TEXT_MARKERS, ...IDENTIFIER_MARKERS]) {
      const tool = cloneSession(session);
      writeString(tool, position, `mcp__docs__${marker}`);
      expect(hasMarker(await exportSession(tool))).toBe(false);
    }
    for (const marker of FREE_TEXT_MARKERS) {
      const bad = cloneSession(session);
      writeString(bad, position, `mcp__${marker}__lookup`);
      const data = await exportSession(bad);
      expect(hasMarker(data)).toBe(false);
    }
  });

  it("drops a free-text tool name instead of keeping its words (finding F1, fixed)", async () => {
    const [session, position] = firstPosition(
      (s, p) => kindOf(s, p) === "name" && p.part === "line" && readString(s, p) === "Read",
    );
    for (const marker of FREE_TEXT_MARKERS) {
      const copy = cloneSession(session);
      writeString(copy, position, marker);
      const data = await exportSession(copy);
      expect(hasMarker(data)).toBe(false);
      expect(data).toContain('"name":"unknown"');
    }
  });

  it("keeps a model id only when it is a lower-case identifier", async () => {
    // Every reply model of the main transcript, so the planted value is the dominant one.
    const session = corpus.find((s) => s.name === "single-agent") as CorpusSession;
    const plantModel = async (marker: string): Promise<string> => {
      const copy = cloneSession(session);
      for (const position of stringPositions(copy)) {
        if (kindOf(copy, position) === "name" && position.path.join("/") === "message/model") {
          writeString(copy, position, marker);
        }
      }
      return exportSession(copy);
    };
    const kept = markerPointers(JSON.parse(await plantModel("zqxtoken0fake0secret0value")));
    expect(kept).toEqual(["/agents/0/model"]);
    const family = markerPointers(JSON.parse(await plantModel("claude-zqxfamily-1")));
    expect(family).toEqual(["/agents/0/model", "/agents/0/family"]);
    for (const marker of [...FREE_TEXT_MARKERS, IDENTIFIER_MARKERS[0] as string]) {
      expect(hasMarker(await plantModel(marker))).toBe(false);
    }
  });

  it("never exports an effort value outside the closed set", async () => {
    const [session, position] = firstPosition(
      (_session, p) => p.part === "line" && p.path.join("/") === "effort",
    );
    for (const marker of ALL_MARKERS) {
      const copy = cloneSession(session);
      writeString(copy, position, marker);
      expect(hasMarker(await exportSession(copy))).toBe(false);
    }
  });
});

describe("the app's drop-a-file path", () => {
  it("never lets a planted value through when the main transcript is dropped as one file", async () => {
    for (const session of corpus) {
      const clean = await exportDroppedFile(session);
      const copy = cloneSession(session);
      stringPositions(copy)
        .filter((p) => p.file === "main" && kindOf(copy, p) === "content")
        .forEach((position, index) => {
          writeString(copy, position, ALL_MARKERS[index % ALL_MARKERS.length] as string);
        });
      const dropped = await exportDroppedFile(copy);
      expect({ session: session.name, data: dropped }).toEqual({
        session: session.name,
        data: clean,
      });
      expect(hasMarker(dropped)).toBe(false);
    }
  });

  it("splits a dropped file on every line break, so a marker line cannot hide in one item", async () => {
    const session = corpus[0] as CorpusSession;
    const copy = cloneSession(session);
    const line = copy.main[0] as JsonObject;
    line["note"] = "zqx\r\nzqx\rzqx";
    expect(hasMarker(await exportDroppedFile(copy))).toBe(false);
  });
});
