import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DEFAULT_THEME,
  browserEnvironment,
  createOrrery,
  createOrreryWithEnvironment,
  type CreateOrrery,
  type CreateOrreryWithEnvironment,
  type OrreryEnvironment,
  type OrreryHandle,
} from "../src/index.js";
import type { OrreryEnvironment as ContractEnvironment } from "../src/api.js";
import type { OrreryEnvironment as ContextEnvironment } from "../src/context.js";

describe("@orbitrace/renderer entry", () => {
  it("exports createOrrery with the contract's type", () => {
    expectTypeOf(createOrrery).toEqualTypeOf<CreateOrrery>();
    expectTypeOf(createOrreryWithEnvironment).parameter(2).toEqualTypeOf<OrreryEnvironment>();
    expectTypeOf(createOrreryWithEnvironment).returns.toEqualTypeOf<OrreryHandle>();
    expect(typeof createOrrery).toBe("function");
    expect(typeof browserEnvironment).toBe("function");
  });

  it("types createOrreryWithEnvironment with the contract, and declares the environment there (#70)", () => {
    expectTypeOf(createOrreryWithEnvironment).toEqualTypeOf<CreateOrreryWithEnvironment>();
    expectTypeOf<Parameters<CreateOrreryWithEnvironment>[2]>().toEqualTypeOf<OrreryEnvironment>();
    expectTypeOf<ContractEnvironment>().toEqualTypeOf<OrreryEnvironment>();
    // The old import place still works and is the same type.
    expectTypeOf<ContextEnvironment>().toEqualTypeOf<ContractEnvironment>();
    expectTypeOf(browserEnvironment).returns.toEqualTypeOf<OrreryEnvironment>();
    expect(typeof createOrreryWithEnvironment).toBe("function");
  });

  it("exports the default theme", () => {
    expect(Object.isFrozen(DEFAULT_THEME)).toBe(true);
    expect(Object.keys(DEFAULT_THEME).sort()).toEqual(
      ["agent", "background", "edit", "failure", "handback", "read", "shell", "text"].sort(),
    );
  });
});
