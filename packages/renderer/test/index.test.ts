import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DEFAULT_THEME,
  browserEnvironment,
  createOrrery,
  createOrreryWithEnvironment,
  type CreateOrrery,
  type OrreryEnvironment,
  type OrreryHandle,
} from "../src/index.js";

describe("@orbitrace/renderer entry", () => {
  it("exports createOrrery with the contract's type", () => {
    expectTypeOf(createOrrery).toEqualTypeOf<CreateOrrery>();
    expectTypeOf(createOrreryWithEnvironment).parameter(2).toEqualTypeOf<OrreryEnvironment>();
    expectTypeOf(createOrreryWithEnvironment).returns.toEqualTypeOf<OrreryHandle>();
    expect(typeof createOrrery).toBe("function");
    expect(typeof browserEnvironment).toBe("function");
  });

  it("exports the default theme", () => {
    expect(Object.isFrozen(DEFAULT_THEME)).toBe(true);
    expect(Object.keys(DEFAULT_THEME).sort()).toEqual(
      ["agent", "background", "edit", "failure", "handback", "read", "shell", "text"].sort(),
    );
  });
});
