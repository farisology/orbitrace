/**
 * Tickets #122 and #123: the opt-in export options on the whole pipeline
 * (`parseSession` -> `buildReplay` -> `exportReplay`) over every synthetic fixture session.
 *
 * - With no option, or each option at its default, the bytes are the committed golden replays,
 *   byte for byte (owner decision: the options are opt-in).
 * - With options, every export is a valid replay v1 under the unchanged schema.
 * - With `names: "opaque"`, none of the session's own identifier-shaped names (agent types, MCP
 *   servers, tool names outside the kept list, model ids that are not known Claude ids) appears
 *   anywhere in the serialised text, and invented identifier-shaped markers planted in every name
 *   position never appear either.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildReplay,
  exportReplay,
  isKnownModelId,
  OPAQUE_KEPT_TOOL_NAMES,
  parseSession,
  validateReplay,
  type ExportOptions,
  type ReplayModel,
} from "../../src/index.js";
import {
  cloneSession,
  goldenText,
  kindOf,
  loadCorpus,
  readString,
  stringPositions,
  toInput,
  writeString,
  type CorpusSession,
  type Position,
} from "./audit-corpus.js";
import { hasMarker, IDENTIFIER_MARKERS, markerPointers } from "./audit-markers.js";

const corpus = loadCorpus();

/** The repository's `fixtures` folder, from this file's place in `packages/core/test/export`. */
const FIXTURES_DIR = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."),
  "fixtures",
);

async function modelOf(session: CorpusSession): Promise<ReplayModel> {
  return buildReplay(await parseSession(toInput(session)));
}

const DEFAULT_SPELLINGS: readonly ExportOptions[] = [
  {},
  { names: "as-written" },
  { bucketTokens: false },
  // A caller that passes `undefined` explicitly (allowed from plain JavaScript).
  { names: "as-written", roundTimes: undefined, bucketTokens: false } as unknown as ExportOptions,
];

const OPT_IN: readonly ExportOptions[] = [
  { names: "opaque" },
  { roundTimes: 0.1 },
  { roundTimes: 1 },
  { roundTimes: 60 },
  { bucketTokens: true },
  { names: "opaque", roundTimes: 0.1, bucketTokens: true },
];

/** The session's own names that `names: "opaque"` must hide, read from the plain export. */
function chosenNames(model: ReplayModel): string[] {
  const kept = new Set(OPAQUE_KEPT_TOOL_NAMES);
  const names = new Set<string>();
  for (const agent of model.agents) {
    if (agent.id !== "main") names.add(agent.name);
    if (agent.model !== null && !isKnownModelId(agent.model)) names.add(agent.model);
    for (const tool of agent.tools) {
      if (tool.name.startsWith("mcp:")) {
        if (tool.name !== "mcp:unknown") names.add(tool.name.slice("mcp:".length));
      } else if (!kept.has(tool.name)) {
        names.add(tool.name);
      }
    }
  }
  return [...names];
}

describe("export with no option (opt-in, owner decision)", () => {
  it("covers every golden replay of the fixture manifest", () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8")) as {
      goldenReplays: string[];
    };
    expect(manifest.goldenReplays.length).toBeGreaterThan(0);
    expect(corpus.map((session) => `replays/${session.name}.replay.json`)).toEqual(
      manifest.goldenReplays,
    );
  });

  it("writes every golden replay byte for byte, however the defaults are spelled", async () => {
    for (const session of corpus) {
      const model = await modelOf(session);
      const golden = goldenText(session.name);
      for (const options of DEFAULT_SPELLINGS) {
        expect(exportReplay(model, { ...options, pretty: true }).data).toBe(golden);
      }
      // A committed golden read back and exported again is the same file.
      expect(exportReplay(JSON.parse(golden) as ReplayModel, { pretty: true }).data).toBe(golden);
      // Compact output is the golden's data without indentation.
      expect(exportReplay(model).data).toBe(`${JSON.stringify(JSON.parse(golden))}\n`);
    }
  });
});

describe("export with opt-in options over every fixture session", () => {
  it("is a valid replay v1 for every option and session, and is byte-stable", async () => {
    for (const session of corpus) {
      const model = await modelOf(session);
      for (const options of OPT_IN) {
        const data = exportReplay(model, options).data;
        expect(validateReplay(JSON.parse(data))).toBe(true);
        expect(exportReplay(model, options).data).toBe(data);
        expect(JSON.parse(exportReplay(model, { ...options, pretty: true }).data)).toEqual(
          JSON.parse(data),
        );
      }
    }
  });

  it("keeps structure and counts: agents, calls, failures, replies, kinds and parents", async () => {
    for (const session of corpus) {
      const model = await modelOf(session);
      const out = JSON.parse(
        exportReplay(model, { names: "opaque", roundTimes: 0.1, bucketTokens: true }).data,
      ) as ReplayModel;
      expect(out.agents.map((a) => [a.id, a.parent, a.wave, a.effort])).toEqual(
        model.agents.map((a) => [a.id, a.parent, a.wave, a.effort]),
      );
      expect(out.agents.map((a) => a.tools.map((t) => [t.kind, t.failed, t.end === null]))).toEqual(
        model.agents.map((a) => a.tools.map((t) => [t.kind, t.failed, t.end === null])),
      );
      for (const key of ["agents", "toolCalls", "failedToolCalls", "replies"] as const) {
        expect(out.totals[key]).toBe(model.totals[key]);
      }
      expect(out.warps).toHaveLength(model.warps.length);
    }
  });

  it(
    "with opaque names, holds none of the session's own names anywhere in the text",
    { timeout: 60_000 },
    async () => {
      let checked = 0;
      for (const session of corpus) {
        const model = await modelOf(session);
        const names = chosenNames(model);
        for (const options of [{ names: "opaque" }, { names: "opaque", pretty: true }] as const) {
          const text = exportReplay(model, options).data;
          for (const name of names) {
            expect(text.includes(name), `${session.name}: a chosen name is still in the text`).toBe(
              false,
            );
            checked += 1;
          }
        }
      }
      // The fixtures hold custom agent types, MCP servers, a custom tool and an unknown model.
      expect(checked).toBeGreaterThan(40);
    },
  );
});

/** Every position whose value an export writes as a name (agent type, model id, tool name). */
function namePositions(session: CorpusSession): Position[] {
  return stringPositions(session).filter((position) => kindOf(session, position) === "name");
}

/** The ways a planted marker can sit in a name position. */
function variants(position: Position, marker: string): string[] {
  const path = position.path;
  const last = path[path.length - 1];
  const isTool = position.part === "line" && path[0] === "message" && last === "name";
  const isModel = last === "model";
  if (isTool) return [marker, `mcp__${marker}__lookup`];
  if (isModel) return [marker, marker.toLowerCase(), `claude-${marker.toLowerCase()}-1-0`];
  return [marker];
}

describe("opaque names against planted identifier-shaped markers", () => {
  it("finds name positions in every session", () => {
    for (const session of corpus) expect(namePositions(session).length).toBeGreaterThan(0);
  });

  it(
    "never writes a marker planted in every name position at once",
    { timeout: 60_000 },
    async () => {
      let runs = 0;
      for (const session of corpus) {
        for (let round = 0; round < 3; round += 1) {
          const copy = cloneSession(session);
          namePositions(copy).forEach((position, index) => {
            const marker = IDENTIFIER_MARKERS[
              (index + round) % IDENTIFIER_MARKERS.length
            ] as string;
            const options = variants(position, marker);
            writeString(copy, position, options[(index + round) % options.length] as string);
          });
          const model = await modelOf(copy);
          // The plain export does carry them, so the planting reached a name field.
          expect(hasMarker(exportReplay(model).data)).toBe(true);
          for (const options of OPT_IN.filter((o) => o.names === "opaque")) {
            const data = exportReplay(model, options).data;
            expect(validateReplay(JSON.parse(data))).toBe(true);
            expect(markerPointers(JSON.parse(data))).toEqual([]);
            expect(hasMarker(data)).toBe(false);
            runs += 1;
          }
        }
      }
      expect(runs).toBe(corpus.length * 3 * 2);
    },
  );

  it(
    "never writes a marker planted in one name position (every position, every variant)",
    { timeout: 60_000 },
    async () => {
      let runs = 0;
      // `demo` has the same line shapes as the rest together and is left out for time, as in the
      // audit's single-position test.
      for (const session of corpus.filter((s) => s.name !== "demo")) {
        for (const position of namePositions(session)) {
          const original = readString(session, position);
          for (const marker of IDENTIFIER_MARKERS) {
            for (const value of variants(position, marker)) {
              writeString(session, position, value);
              try {
                const model = await modelOf(session);
                const data = exportReplay(model, { names: "opaque" }).data;
                expect(validateReplay(JSON.parse(data))).toBe(true);
                expect(hasMarker(data), `${session.name} ${position.path.join(".")}`).toBe(false);
                runs += 1;
              } finally {
                writeString(session, position, original);
              }
            }
          }
        }
      }
      expect(runs).toBeGreaterThan(100);
    },
  );
});
