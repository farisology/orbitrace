import { describe, expect, it } from "vitest";
import { buildValidatorSource, GENERATED_VALIDATOR_PATH } from "./validator-source.js";

describe("generated replay v1 validator", () => {
  it("matches the schema (regenerate with: npx vitest run -u test/export/validator-source.test.ts)", async () => {
    const source = await buildValidatorSource();
    await expect(source).toMatchFileSnapshot(GENERATED_VALIDATOR_PATH);
  }, 30_000);

  it("uses no eval, no Function constructor and no imports", async () => {
    const source = await buildValidatorSource();
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bFunction\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\s/m);
  }, 30_000);
});
