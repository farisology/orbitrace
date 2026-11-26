import { describe, expect, it } from "vitest";
import schema from "../../schema/replay-v1.schema.json" with { type: "json" };
import { projectReplay } from "../../src/export/project.js";
import { arr, makeModel, mutableCopy, obj, PLANTED } from "./model.js";

type Defs = typeof schema.$defs;

function requiredOf(name: keyof Defs): readonly string[] {
  return (schema.$defs[name] as { required: readonly string[] }).required;
}

describe("projectReplay", () => {
  it("writes exactly the schema's properties, in schema order, on every object", () => {
    const projected = obj(projectReplay(makeModel()));
    expect(Object.keys(projected)).toEqual(schema.required);
    expect(Object.keys(obj(projected.totals))).toEqual(requiredOf("sessionTotals"));
    for (const [index, agent] of arr(projected.agents).entries()) {
      const a = obj(agent);
      expect(Object.keys(a)).toEqual(requiredOf(index === 0 ? "mainAgent" : "subagent"));
      expect(Object.keys(obj(a.totals))).toEqual(requiredOf("agentTotals"));
      for (const tool of arr(a.tools))
        expect(Object.keys(obj(tool))).toEqual(requiredOf("toolCall"));
      for (const reply of arr(a.replies))
        expect(Object.keys(obj(reply))).toEqual(requiredOf("reply"));
    }
    for (const warp of arr(projected.warps))
      expect(Object.keys(obj(warp))).toEqual(requiredOf("warp"));
  });

  it("builds new objects and arrays instead of reusing the input's", () => {
    const model = makeModel();
    const projected = obj(projectReplay(model));
    expect(projected).toEqual(model);
    expect(projected).not.toBe(model);
    expect(projected.agents).not.toBe(model.agents);
    expect(obj(arr(projected.agents)[0]).tools).not.toBe(model.agents[0].tools);
    expect(obj(arr(projected.agents)[0]).totals).not.toBe(model.agents[0].totals);
  });

  it("drops properties that are not listed, on objects and on arrays", () => {
    const model = mutableCopy(makeModel());
    model.text = PLANTED;
    (arr(model.agents) as unknown as Record<string, unknown>).cwd = PLANTED;
    obj(arr(model.warps)[0]).description = PLANTED;
    expect(JSON.stringify(projectReplay(model))).not.toContain(PLANTED);
  });

  it("replaces non-primitive leaves with an empty object and keeps missing fields missing", () => {
    const model = mutableCopy(makeModel());
    const agent = obj(arr(model.agents)[1]);
    agent.name = { text: PLANTED };
    agent.start = [PLANTED];
    agent.end = () => PLANTED;
    delete agent.model;
    const projected = obj(arr(obj(projectReplay(model)).agents)[1]);
    expect(projected.name).toEqual({});
    expect(projected.start).toEqual({});
    expect(projected.end).toEqual({});
    expect(projected.model).toBeUndefined();
    expect("model" in projected).toBe(true);
  });

  it("returns an empty object for a value that is not an object", () => {
    for (const value of [null, undefined, 1, "x", [makeModel()]]) {
      expect(projectReplay(value)).toEqual({});
    }
  });

  it("turns a non-array list into an empty object so the schema rejects it", () => {
    const model = mutableCopy(makeModel());
    model.warps = { 0: { at: 1, skipped: 1 } };
    expect(obj(projectReplay(model)).warps).toEqual({});
  });
});
