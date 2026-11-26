import { describe, expect, it } from "vitest";
import minimal from "../../../../fixtures/replays/minimal.replay.json" with { type: "json" };
import {
  exportReplay,
  FORBIDDEN_REPLAY_KEYS,
  REPLAY_EXPORT_FILE_NAME,
  ReplayValidationError,
  validateReplay,
  type ReplayModel,
} from "../../src/index.js";
import { arr, makeModel, mutableCopy, obj, PLANTED, walk } from "./model.js";

/** Exports a value that is not typed as a model (planted or broken input). */
function exportLoose(value: unknown): string {
  return exportReplay(value as ReplayModel).data;
}

function expectRejected(value: unknown): ReplayValidationError {
  try {
    exportLoose(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayValidationError);
    return error as ReplayValidationError;
  }
  throw new Error("expected exportReplay to throw");
}

/** Plants PLANTED under every forbidden key, plus invented ones, on an object or array. */
function plant(node: object): void {
  const target = node as Record<string, unknown>;
  for (const key of [...FORBIDDEN_REPLAY_KEYS, "notes", "env"]) target[key] = PLANTED;
  target.nested = { text: PLANTED, path: `src/${PLANTED}.ts` };
}

/** Every object and array of a model copy, so a test can plant on all of them. */
function everyNode(model: Record<string, unknown>): object[] {
  const nodes: object[] = [model, arr(model.agents), arr(model.warps), obj(model.totals)];
  for (const agent of arr(model.agents)) {
    const a = obj(agent);
    nodes.push(a, obj(a.totals), arr(a.tools), arr(a.replies));
    for (const tool of arr(a.tools)) nodes.push(obj(tool));
    for (const reply of arr(a.replies)) nodes.push(obj(reply));
  }
  for (const w of arr(model.warps)) nodes.push(obj(w));
  return nodes;
}

describe("exportReplay", () => {
  it("round-trips a clean model", () => {
    const model = makeModel();
    const result = exportReplay(model);
    expect(result.format).toBe("replay-json");
    expect(result.mediaType).toBe("application/json");
    expect(result.fileName).toBe(REPLAY_EXPORT_FILE_NAME);
    expect(result.fileName.endsWith(".replay.json")).toBe(true);
    expect(result.data.endsWith("\n")).toBe(true);
    const parsed: unknown = JSON.parse(result.data);
    expect(parsed).toEqual(model);
    expect(validateReplay(parsed)).toBe(true);
  });

  it("round-trips the synthetic fixture", () => {
    const parsed: unknown = JSON.parse(exportLoose(minimal));
    expect(parsed).toEqual(minimal);
  });

  it("writes compact JSON by default and indented JSON when pretty", () => {
    const model = makeModel();
    const compact = exportReplay(model).data;
    const pretty = exportReplay(model, { pretty: true, format: "replay-json" }).data;
    expect(compact.trimEnd()).not.toContain("\n");
    expect(pretty).toContain('\n  "agents": [');
    expect(JSON.parse(pretty)).toEqual(JSON.parse(compact));
  });

  it("is byte-stable for the same input, whatever the key order", () => {
    const model = makeModel();
    const first = exportReplay(model).data;
    expect(exportReplay(model).data).toBe(first);
    expect(exportReplay(makeModel()).data).toBe(first);

    const reverseKeys = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(reverseKeys);
      if (typeof node !== "object" || node === null) return node;
      const entries = Object.entries(node).reverse();
      return Object.fromEntries(entries.map(([key, value]) => [key, reverseKeys(value)]));
    };
    expect(exportLoose(reverseKeys(model))).toBe(first);
    expect(exportReplay(model, { pretty: true }).data).toBe(
      exportReplay(makeModel(), { pretty: true }).data,
    );
  });

  it("drops planted extra properties at every nesting level", () => {
    const clean = exportReplay(makeModel()).data;
    const planted = mutableCopy(makeModel());
    const nodes = everyNode(planted);
    expect(nodes.length).toBeGreaterThan(20);
    for (const node of nodes) plant(node);
    const symbol = Symbol("planted");
    (planted as Record<symbol, unknown>)[symbol] = PLANTED;
    Object.defineProperty(obj(arr(planted.agents)[1]), "hidden", { value: PLANTED });

    const data = exportLoose(planted);
    expect(data).toBe(clean);
    expect(data).not.toContain(PLANTED);
    const { keys } = walk(JSON.parse(data));
    for (const key of FORBIDDEN_REPLAY_KEYS) expect(keys).not.toContain(key);
    expect(keys).not.toContain("nested");
  });

  it("does not pick up a field from a prototype", () => {
    const model = mutableCopy(makeModel());
    const tools = arr(obj(arr(model.agents)[0]).tools);
    const rest = { ...obj(tools[0]) };
    delete rest.name;
    tools[0] = Object.assign(Object.create({ name: "Read", text: PLANTED }) as object, rest);
    const error = expectRejected(model);
    expect(error.problems).toContain("/agents/0/tools/0: must have required property 'name'");
  });

  it("rejects free text, paths and command lines in identifier fields without echoing them", () => {
    const cases: [(m: Record<string, unknown>) => void, string][] = [
      [(m) => (obj(arr(m.agents)[1]).name = "review the invented widget module"), "/agents/1/name"],
      [
        (m) => (obj(arr(obj(arr(m.agents)[0]).tools)[0]).name = "src/widget.ts"),
        "/agents/0/tools/0/name",
      ],
      [(m) => (obj(arr(m.agents)[2]).callsign = "npm run build"), "/agents/2/callsign"],
      [(m) => (obj(arr(m.agents)[1]).model = "C:\\example\\model"), "/agents/1/model"],
      [(m) => (obj(arr(m.agents)[1]).name = "widget-reviewer\n"), "/agents/1/name"],
      [(m) => (obj(arr(m.agents)[1]).family = "opus sonnet"), "/agents/1/family"],
    ];
    for (const [mutate, pointer] of cases) {
      const model = mutableCopy(makeModel());
      mutate(model);
      const error = expectRejected(model);
      expect(error.problems.some((p) => p.startsWith(`${pointer}: `))).toBe(true);
      expect(error.message).not.toMatch(/invented widget|src\/widget|npm run|example\\\\model/);
    }
  });

  it("replaces a nested value in a leaf field and rejects it without echoing it", () => {
    const model = mutableCopy(makeModel());
    obj(arr(model.agents)[1]).name = { text: PLANTED };
    const error = expectRejected(model);
    expect(error.problems).toContain("/agents/1/name: must be string");
    expect(error.message).not.toContain(PLANTED);
  });

  it("rejects NaN, Infinity and negative times", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const model = mutableCopy(makeModel());
      obj(arr(model.agents)[0]).start = value;
      const error = expectRejected(model);
      expect(error.problems.some((p) => p.startsWith("/agents/0/start: "))).toBe(true);
    }
  });

  it("rejects another format version", () => {
    const model = mutableCopy(makeModel());
    model.formatVersion = 2;
    expect(expectRejected(model).problems).toContain("/formatVersion: must be equal to constant");
  });

  it("rejects a missing field instead of filling it in", () => {
    const model = mutableCopy(makeModel());
    delete obj(arr(model.agents)[1]).tools;
    expect(expectRejected(model).problems).toContain(
      "/agents/1: must have required property 'tools'",
    );
  });

  it("rejects values that are not a replay at all", () => {
    for (const value of [null, undefined, "a string", 42, [], [makeModel()]]) {
      const error = expectRejected(value);
      expect(error.problems.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown options", () => {
    const model = makeModel();
    expect(() => exportReplay(model, { format: "csv" as never })).toThrow(TypeError);
    expect(() => exportReplay(model, { pretty: "yes" as never })).toThrow(TypeError);
  });

  it("writes no string with a space, slash, backslash or line break", () => {
    const { strings } = walk(JSON.parse(exportReplay(makeModel()).data));
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) expect(value).toMatch(/^[A-Za-z0-9._:#-]+$/);
  });
});
