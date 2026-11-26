import { describe, expect, it } from "vitest";
import {
  assertReplay,
  describeReplayProblems,
  MAX_REPORTED_PROBLEMS,
  ReplayValidationError,
  validateReplay,
} from "../../src/index.js";
import { arr, makeModel, mutableCopy, obj, PLANTED } from "./model.js";
import { compileReferenceValidator } from "./validator-source.js";

describe("validateReplay", () => {
  it("accepts a clean model and its JSON round trip", () => {
    const model = makeModel();
    expect(validateReplay(model)).toBe(true);
    expect(validateReplay(JSON.parse(JSON.stringify(model)))).toBe(true);
  });

  it("narrows the type of an unknown value", () => {
    const value: unknown = JSON.parse(JSON.stringify(makeModel()));
    if (!validateReplay(value)) throw new Error("expected a valid replay");
    expect(value.agents[0].id).toBe("main");
  });

  it("rejects extra properties instead of dropping them", () => {
    const model = mutableCopy(makeModel());
    obj(arr(model.agents)[1]).text = PLANTED;
    expect(validateReplay(model)).toBe(false);
  });

  it("rejects values that are not a replay", () => {
    for (const value of [null, undefined, 0, "", [], {}, { formatVersion: 1 }]) {
      expect(validateReplay(value)).toBe(false);
    }
  });
});

describe("describeReplayProblems", () => {
  it("returns no problems for a valid model", () => {
    expect(describeReplayProblems(makeModel())).toEqual([]);
  });

  it("names the location and the rule", () => {
    const model = mutableCopy(makeModel());
    obj(arr(model.agents)[1]).text = PLANTED;
    obj(arr(obj(arr(model.agents)[0]).tools)[1]).kind = "write";
    delete obj(model.totals).duration;
    const problems = describeReplayProblems(model);
    expect(problems).toContain('/agents/1: has a property the format does not allow: "text"');
    expect(problems).toContain(
      "/agents/0/tools/1/kind: must be equal to one of the allowed values",
    );
    expect(problems).toContain("/totals: must have required property 'duration'");
  });

  it("describes a value that is not an object", () => {
    expect(describeReplayProblems("a string")).toContain("(root): must be object");
  });

  it("never quotes a value, and hides a property name that is not an identifier", () => {
    const model = mutableCopy(makeModel());
    obj(arr(model.agents)[1]).name = `${PLANTED} with spaces`;
    obj(model.totals)[`${PLANTED} key`] = 1;
    const problems = describeReplayProblems(model);
    expect(problems).toContain(
      "/totals: has a property the format does not allow (name not shown)",
    );
    expect(problems.join("\n")).not.toContain(PLANTED);
  });

  it(`lists at most ${MAX_REPORTED_PROBLEMS} problems and counts the rest`, () => {
    const model = mutableCopy(makeModel());
    for (let i = 0; i < 30; i += 1) model[`extra${i}`] = i;
    const problems = describeReplayProblems(model);
    expect(problems).toHaveLength(MAX_REPORTED_PROBLEMS + 1);
    expect(problems.at(-1)).toBe("... and 10 more");
  });
});

describe("assertReplay and ReplayValidationError", () => {
  it("passes a valid model", () => {
    expect(() => assertReplay(makeModel())).not.toThrow();
  });

  it("throws with every problem listed", () => {
    const model = mutableCopy(makeModel());
    model.formatVersion = 2;
    let caught: unknown;
    try {
      assertReplay(model);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReplayValidationError);
    const error = caught as ReplayValidationError;
    expect(error.name).toBe("ReplayValidationError");
    expect(error.problems).toEqual(["/formatVersion: must be equal to constant"]);
    expect(error.message).toBe(
      "Not a valid Orbitrace replay (format version 1):\n- /formatVersion: must be equal to constant",
    );
  });
});

describe("generated validator", () => {
  it("agrees with Ajv compiling the schema at run time", () => {
    const reference = compileReferenceValidator();
    const variants: unknown[] = [makeModel(), null, {}, [], "x"];
    const mutations: ((m: Record<string, unknown>) => void)[] = [
      (m) => (m.text = PLANTED),
      (m) => (m.formatVersion = 2),
      (m) => (m.agents = []),
      (m) => (obj(arr(m.agents)[0]).id = "a1"),
      (m) => (obj(arr(m.agents)[2]).parent = null),
      (m) => (obj(arr(m.agents)[1]).wave = 1.5),
      (m) => (obj(arr(obj(arr(m.agents)[0]).tools)[2]).kind = "read"),
      (m) => (obj(arr(obj(arr(m.agents)[0]).tools)[0]).name = "mcp__example__tool"),
      (m) => (obj(arr(obj(arr(m.agents)[1]).replies)[0]).outputTokens = -1),
      (m) => (obj(arr(m.warps)[0]).skipped = 0),
      (m) => (obj(arr(m.agents)[1]).effort = "extreme"),
      (m) => (obj(arr(m.agents)[1]).family = "Sonnet"),
      (m) => (obj(m.totals).realDuration = Number.NaN),
    ];
    for (const mutate of mutations) {
      const model = mutableCopy(makeModel());
      mutate(model);
      variants.push(model);
    }
    for (const [index, value] of variants.entries()) {
      expect({ index, ok: validateReplay(value) }).toEqual({ index, ok: reference(value) });
    }
    expect(variants.filter((value) => validateReplay(value))).toHaveLength(1);
  });
});
