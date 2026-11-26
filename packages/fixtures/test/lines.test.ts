import { KNOWN_MODEL_FAMILIES, type KnownModelFamily } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_AGENT_TYPES,
  COMMON_LINE_KEYS,
  CONVERSATION_LINE_TYPES,
  HOUSEKEEPING_LINE_TYPES,
  INVENTED_LINE_TYPES,
  KNOWN_RAW_LINE_TYPES,
  MODELS,
  SUBAGENT_META_KEYS,
  USAGE_KEYS,
  addUsage,
  isKnownLineType,
  maxUsage,
  zeroUsage,
  type FullUsage,
} from "../src/index.js";

const a: FullUsage = {
  input_tokens: 5,
  output_tokens: 100,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
};
const b: FullUsage = {
  input_tokens: 9,
  output_tokens: 40,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 300,
};

describe("usage helpers", () => {
  it("zeroUsage has every usage key at zero and returns a new object each time", () => {
    expect(Object.keys(zeroUsage()).sort()).toEqual([...USAGE_KEYS].sort());
    expect(Object.values(zeroUsage())).toEqual([0, 0, 0, 0]);
    expect(zeroUsage()).not.toBe(zeroUsage());
  });

  it("maxUsage takes the larger value of each field", () => {
    expect(maxUsage(a, b)).toEqual({
      input_tokens: 9,
      output_tokens: 100,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
    });
    expect(maxUsage(a, zeroUsage())).toEqual(a);
  });

  it("addUsage sums each field", () => {
    expect(addUsage(a, b)).toEqual({
      input_tokens: 14,
      output_tokens: 140,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 300,
    });
    expect(addUsage(a, zeroUsage())).toEqual(a);
  });
});

describe("line constants", () => {
  it("lists the keys and types the format notes describe", () => {
    expect(COMMON_LINE_KEYS).toEqual([
      "type",
      "uuid",
      "parentUuid",
      "timestamp",
      "sessionId",
      "cwd",
      "gitBranch",
      "version",
      "entrypoint",
      "isSidechain",
    ]);
    expect(SUBAGENT_META_KEYS).toEqual([
      "agentType",
      "model",
      "toolUseId",
      "spawnDepth",
      "description",
      "isBuiltIn",
      "finished",
    ]);
  });

  it("splits the contract's known line types into conversation and housekeeping", () => {
    expect(CONVERSATION_LINE_TYPES).toEqual(["user", "assistant", "system", "attachment"]);
    // Housekeeping is derived: every known type that is not a conversation type, in the
    // contract's order. Nothing is listed twice and nothing is left out.
    expect(HOUSEKEEPING_LINE_TYPES).toEqual(
      KNOWN_RAW_LINE_TYPES.filter(
        (type) => !(CONVERSATION_LINE_TYPES as readonly string[]).includes(type),
      ),
    );
    expect(HOUSEKEEPING_LINE_TYPES.length).toBeGreaterThan(0);
    expect([...CONVERSATION_LINE_TYPES, ...HOUSEKEEPING_LINE_TYPES].sort()).toEqual(
      [...KNOWN_RAW_LINE_TYPES].sort(),
    );
  });

  it("isKnownLineType accepts the contract's line types and nothing else", () => {
    for (const type of KNOWN_RAW_LINE_TYPES) expect(isKnownLineType(type)).toBe(true);
    for (const type of INVENTED_LINE_TYPES) expect(isKnownLineType(type)).toBe(false);
    for (const value of ["", "User", "tool_use", undefined, null, 7]) {
      expect(isKnownLineType(value)).toBe(false);
    }
  });

  it("keeps invented line types apart from the contract's known ones", () => {
    expect(new Set(INVENTED_LINE_TYPES).size).toBe(INVENTED_LINE_TYPES.length);
    for (const type of INVENTED_LINE_TYPES) {
      expect(KNOWN_RAW_LINE_TYPES as readonly string[]).not.toContain(type);
      expect(type.startsWith("synthetic-")).toBe(true);
    }
  });

  it("names a model per family, with the family right after the claude- prefix", () => {
    expect(MODELS.fable.split("-")[1]).toBe("fable");
    expect(MODELS.opus.split("-")[1]).toBe("opus");
    expect(MODELS.sonnet.split("-")[1]).toBe("sonnet");
    expect(MODELS.haiku.split("-")[1]).toBe("haiku");
    expect(MODELS.haikuDated.split("-")[1]).toBe("haiku");
    // The contract's known families, less its own placeholder for an unknown one.
    const families = KNOWN_MODEL_FAMILIES.filter(
      (family): family is Exclude<KnownModelFamily, "unknown"> => family !== "unknown",
    );
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) expect(MODELS[family].split("-")[1]).toBe(family);
    expect(KNOWN_MODEL_FAMILIES as readonly string[]).not.toContain(
      MODELS.unknownFamily.split("-")[1],
    );
    expect(BUILT_IN_AGENT_TYPES).toContain("general-purpose");
  });
});
