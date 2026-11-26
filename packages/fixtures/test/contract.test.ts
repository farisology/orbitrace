/**
 * The fixtures against the raw-line contract in @orbitrace/core.
 *
 * This package does not define the raw line vocabulary. It imports it from the contract,
 * and these tests fail when the two drift apart: at type level (checked by `npm run
 * typecheck`) and against the lines in the generated and the committed files.
 */
import { readFileSync } from "node:fs";
import * as core from "@orbitrace/core";
import type {
  RawLineBase,
  RawSubagentInput,
  RawSubagentMeta as CoreSubagentMeta,
  RawUsage as CoreUsage,
  SessionInput,
} from "@orbitrace/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  COMMON_LINE_KEYS,
  DEFAULT_SEED,
  INVENTED_LINE_TYPES,
  KNOWN_EFFORT_LEVELS,
  KNOWN_RAW_LINE_TYPES,
  SCENARIO_NAMES,
  SUBAGENT_META_KEYS,
  USAGE_KEYS,
  fixturePaths,
  generateSession,
  isKnownLineType,
  maxUsage,
  zeroUsage,
  type AgentFacts,
  type AgentWriter,
  type DeclaredKeys,
  type FullUsage,
  type GeneratedSession,
  type GeneratedSubagent,
  type KnownEffortLevel,
  type KnownRawLineType,
  type RawLine,
  type RawSubagentMeta,
  type RawUsage,
  type ReplyHandle,
  type SubagentSpec,
} from "../src/index.js";
import { allTranscripts, parseJsonl, readSession, type JsonObject } from "./helpers.js";

const SEEDS = [DEFAULT_SEED, "0", "contract-check"];

/** A generated session in the shape the contract's parser takes as input. */
function toSessionInput(session: GeneratedSession): SessionInput {
  const content = (path: string): string[] => {
    const file = session.files.find((candidate) => candidate.path === path);
    if (file === undefined) throw new Error(`no generated file at ${path}`);
    return file.content.slice(0, -1).split("\n");
  };
  return {
    main: content(session.transcriptPath),
    subagents: session.subagents.map((subagent) => ({
      agentId: subagent.agentId,
      meta: subagent.meta,
      lines: content(subagent.transcriptPath),
    })),
  };
}

/** Number of lines per `type` over a list of transcripts. */
function countTypes(transcripts: readonly (readonly JsonObject[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lines of transcripts) {
    for (const line of lines) {
      const type = String(line.type);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return counts;
}

/** The parsed transcripts of the files committed under fixtures/ for one scenario. */
function committedTranscripts(name: (typeof SCENARIO_NAMES)[number]): JsonObject[][] {
  const paths = fixturePaths(name);
  return [paths.transcript, ...paths.subagents.map((subagent) => subagent.transcript)].map((path) =>
    parseJsonl(readFileSync(path, "utf8")),
  );
}

describe("types come from the contract", () => {
  it("re-exports the contract's constants, not copies of them", () => {
    expect(KNOWN_RAW_LINE_TYPES).toBe(core.KNOWN_RAW_LINE_TYPES);
    expect(KNOWN_EFFORT_LEVELS).toBe(core.KNOWN_EFFORT_LEVELS);
    expectTypeOf<KnownRawLineType>().toEqualTypeOf<core.KnownRawLineType>();
    expectTypeOf<KnownEffortLevel>().toEqualTypeOf<core.KnownEffortLevel>();
    expectTypeOf<RawLine>().toEqualTypeOf<core.RawLine>();
    expectTypeOf<RawSubagentMeta>().toEqualTypeOf<CoreSubagentMeta>();
    expectTypeOf<RawUsage>().toEqualTypeOf<CoreUsage>();
  });

  it("a generated line is a RawLine and a generated meta object is a RawSubagentMeta", () => {
    expectTypeOf<AgentWriter["lines"][number]>().toExtend<core.RawLine>();
    expectTypeOf<GeneratedSubagent["meta"]>().toExtend<CoreSubagentMeta>();

    const session = generateSession("two-waves");
    const first = session.subagents[0];
    expectTypeOf(first).toExtend<{ meta: CoreSubagentMeta } | undefined>();
    // At run time the object is what the meta file holds.
    const metaFile = session.files.find((file) => file.path === first?.metaPath);
    expect(JSON.parse(metaFile?.content ?? "null")).toEqual(first?.meta);
  });

  it("the usage the generator writes is the contract's usage with every count present", () => {
    expectTypeOf<FullUsage>().toExtend<CoreUsage>();
    expectTypeOf<FullUsage>().toEqualTypeOf<
      Required<Pick<CoreUsage, (typeof USAGE_KEYS)[number]>>
    >();
    expectTypeOf<FullUsage[keyof FullUsage]>().toEqualTypeOf<number>();
    expectTypeOf<ReplyHandle["usage"]>().toExtend<CoreUsage>();
    expectTypeOf<AgentFacts["usage"]>().toExtend<CoreUsage>();
    expectTypeOf(maxUsage(zeroUsage(), zeroUsage())).toExtend<CoreUsage>();
  });

  it("an agent's effort is one of the contract's effort levels", () => {
    expectTypeOf<SubagentSpec["effort"]>().toEqualTypeOf<core.KnownEffortLevel>();
    expectTypeOf<AgentFacts["effort"]>().toEqualTypeOf<core.KnownEffortLevel>();
  });

  it("the key lists name every key the contract types declare, and no other", () => {
    expectTypeOf<(typeof COMMON_LINE_KEYS)[number]>().toEqualTypeOf<DeclaredKeys<RawLineBase>>();
    expectTypeOf<(typeof USAGE_KEYS)[number]>().toEqualTypeOf<DeclaredKeys<CoreUsage>>();
    expectTypeOf<(typeof SUBAGENT_META_KEYS)[number]>().toEqualTypeOf<
      DeclaredKeys<CoreSubagentMeta>
    >();
    for (const keys of [COMMON_LINE_KEYS, USAGE_KEYS, SUBAGENT_META_KEYS]) {
      expect(new Set<string>(keys).size).toBe(keys.length);
    }
  });

  it("DeclaredKeys drops the index signature and keeps the named keys", () => {
    interface Sample {
      readonly named?: string;
      readonly other: number;
      readonly [key: string]: unknown;
    }
    expectTypeOf<DeclaredKeys<Sample>>().toEqualTypeOf<"named" | "other">();
    expectTypeOf<DeclaredKeys<{ plain: boolean }>>().toEqualTypeOf<"plain">();
    expectTypeOf<keyof Sample>().toEqualTypeOf<string | number>();
  });

  it("a generated session fits the parser's input type", () => {
    const session = generateSession("two-waves");
    const input = toSessionInput(session);
    expectTypeOf(input).toExtend<SessionInput>();
    expectTypeOf<SessionInput["subagents"][number]>().toEqualTypeOf<RawSubagentInput>();
    expect(input.subagents.map((subagent) => subagent.agentId)).toEqual(
      session.subagents.map((subagent) => subagent.agentId),
    );
    // The line sources are plain text lines, one JSON object each, as a parser reads them.
    const sources = [input.main, ...input.subagents.map((subagent) => subagent.lines)];
    expect(sources).toHaveLength(1 + session.subagents.length);
    for (const source of sources) {
      const lines = [...(source as Iterable<string>)];
      expect(lines.length).toBeGreaterThan(0);
      for (const text of lines) {
        const line = JSON.parse(text) as RawLine;
        expect(typeof line.type).toBe("string");
      }
    }
  });
});

describe("line types in the fixtures", () => {
  it.each(SEEDS)(
    "generated with seed %s: known types are the contract's, invented are not",
    (seed) => {
      const invented = new Set<string>(INVENTED_LINE_TYPES);
      const seen = new Set<string>();
      for (const name of SCENARIO_NAMES) {
        const transcripts = readSession(generateSession(name, { seed }));
        const lists = allTranscripts(transcripts).map(([, lines]) => lines);
        for (const type of countTypes(lists).keys()) {
          seen.add(type);
          // Either the generator declares the type as invented, or the contract knows it.
          expect([name, type, isKnownLineType(type)]).toEqual([name, type, !invented.has(type)]);
        }
      }
      // The fixtures exercise every type the contract knows and every invented one.
      expect([...seen].filter((type) => !invented.has(type)).sort()).toEqual(
        [...core.KNOWN_RAW_LINE_TYPES].sort(),
      );
      expect([...seen].filter((type) => invented.has(type)).sort()).toEqual(
        [...INVENTED_LINE_TYPES].sort(),
      );
    },
  );

  it("committed files: known types are the contract's, invented are not", () => {
    const invented = new Set<string>(INVENTED_LINE_TYPES);
    const counts = countTypes(SCENARIO_NAMES.flatMap((name) => committedTranscripts(name)));
    expect(counts.size).toBeGreaterThan(0);
    for (const type of counts.keys()) {
      expect([type, isKnownLineType(type)]).toEqual([type, !invented.has(type)]);
    }
    expect([...counts.keys()].filter((type) => !invented.has(type)).sort()).toEqual(
      [...core.KNOWN_RAW_LINE_TYPES].sort(),
    );
    expect([...counts.keys()].filter((type) => invented.has(type)).sort()).toEqual(
      [...INVENTED_LINE_TYPES].sort(),
    );
  });

  it("the facts count the same invented lines the files hold", () => {
    for (const name of SCENARIO_NAMES) {
      const session = generateSession(name);
      const lists = allTranscripts(readSession(session)).map(([, lines]) => lines);
      const counted: Record<string, number> = {};
      for (const [type, count] of countTypes(lists)) {
        if (!isKnownLineType(type)) counted[type] = count;
      }
      expect([name, session.expected.inventedLineTypes]).toEqual([name, counted]);
    }
  });
});

describe("values on the lines", () => {
  it("every effort on a line is one of the contract's effort levels, and all are used", () => {
    const seen = new Set<unknown>();
    for (const name of SCENARIO_NAMES) {
      for (const lines of committedTranscripts(name)) {
        for (const line of lines) {
          if (line.type !== "assistant" || !("effort" in line)) continue;
          seen.add(line.effort);
          expect(core.KNOWN_EFFORT_LEVELS as readonly unknown[]).toContain(line.effort);
        }
      }
    }
    expect(seen).toEqual(new Set(core.KNOWN_EFFORT_LEVELS));
  });

  it("every meta file holds only keys the contract declares, with the declared value types", () => {
    const valueTypes: Record<(typeof SUBAGENT_META_KEYS)[number], string> = {
      agentType: "string",
      model: "string",
      toolUseId: "string",
      spawnDepth: "number",
      description: "string",
      isBuiltIn: "boolean",
      finished: "boolean",
    };
    let checked = 0;
    for (const name of SCENARIO_NAMES) {
      for (const subagent of fixturePaths(name).subagents) {
        const meta = JSON.parse(readFileSync(subagent.meta, "utf8")) as JsonObject;
        for (const [key, value] of Object.entries(meta)) {
          expect(SUBAGENT_META_KEYS as readonly string[]).toContain(key);
          expect([key, typeof value]).toEqual([
            key,
            valueTypes[key as (typeof SUBAGENT_META_KEYS)[number]],
          ]);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
