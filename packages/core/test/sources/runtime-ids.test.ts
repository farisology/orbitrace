// The list of runtime ids beside `RuntimeId` (#94).
import { describe, expect, expectTypeOf, it } from "vitest";
import { RUNTIME_IDS, type RuntimeId, type SourceAdapter } from "../../src/index.js";

describe("RUNTIME_IDS", () => {
  it("lists every RuntimeId once, and RuntimeId follows it", () => {
    expectTypeOf<(typeof RUNTIME_IDS)[number]>().toEqualTypeOf<RuntimeId>();
    expectTypeOf<SourceAdapter["runtime"]>().toEqualTypeOf<RuntimeId>();
    expect(RUNTIME_IDS).toEqual(["claude-code"]);
    expect(new Set(RUNTIME_IDS).size).toBe(RUNTIME_IDS.length);
  });
});
