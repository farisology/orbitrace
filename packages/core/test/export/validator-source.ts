// Builds the source of src/export/replay-v1-validator.generated.ts from the replay v1 schema.
//
// Runs in tests only (Node, dev dependencies). The shipped code imports the generated file, so
// export and validation need neither Ajv nor `new Function` at run time, and work in a browser,
// an editor webview with a strict content security policy, and Node.
import { Ajv2020, type Options } from "ajv/dist/2020.js";
import * as standalone from "ajv/dist/standalone/index.js";
import ajvPackage from "ajv/package.json" with { type: "json" };
import { format, resolveConfig } from "prettier";
import schema from "../../schema/replay-v1.schema.json" with { type: "json" };

/** Path of the generated file, relative to this folder. */
export const GENERATED_VALIDATOR_PATH = "../../src/export/replay-v1-validator.generated.ts";

/**
 * Ajv options. `strict`, `strictTuples: false` and `allowUnionTypes` are the contract's own
 * settings (test/replay-schema.test.ts): `agents` is an open tuple on purpose, `prefixItems`
 * fixes the main agent and `items` allows any number of subagents, so `strictTuples` must be off.
 * `strict: true` also turns on `strictNumbers`, which rejects NaN and Infinity.
 * `allErrors` reports every problem instead of the first one.
 */
export const VALIDATOR_AJV_OPTIONS = {
  strict: true,
  strictTuples: false,
  allowUnionTypes: true,
  allErrors: true,
} as const satisfies Options;

/** A validator compiled at run time with the same options, for differential tests. */
export function compileReferenceValidator(): ReturnType<Ajv2020["compile"]> {
  return new Ajv2020(VALIDATOR_AJV_OPTIONS).compile(schema);
}

type StandaloneCode = (ajv: Ajv2020, refsOrFunc?: ReturnType<Ajv2020["compile"]>) => string;

function standaloneCode(): StandaloneCode {
  // ajv/dist/standalone is CommonJS with both `module.exports` and `exports.default` set to the
  // function; which one an ES import sees depends on the loader.
  const mod = standalone as unknown as { default: StandaloneCode | { default: StandaloneCode } };
  return typeof mod.default === "function" ? mod.default : mod.default.default;
}

const HEADER = [
  "/* eslint-disable */",
  "// @ts-nocheck",
  "// GENERATED FILE. Do not edit by hand.",
  "//",
  "// Precompiled validator for packages/core/schema/replay-v1.schema.json, produced by Ajv",
  `// ${ajvPackage.version} standalone code with the options in test/export/validator-source.ts.`,
  "// Shipping precompiled code means export and validation need no Ajv and no `new Function`",
  "// at run time. test/export/validator-source.test.ts fails when this file no longer matches",
  "// the schema. To regenerate, from packages/core run:",
  "//   npx vitest run -u test/export/validator-source.test.ts",
  "",
].join("\n");

/** Full text of the generated file, formatted with the repository's Prettier settings. */
export async function buildValidatorSource(): Promise<string> {
  const ajv = new Ajv2020({ ...VALIDATOR_AJV_OPTIONS, code: { source: true, esm: true } });
  const code = standaloneCode()(ajv, ajv.compile(schema));
  // The Prettier config is repository-wide, so any path inside the repository finds it.
  const config = (await resolveConfig("src/export/replay-v1-validator.generated.ts")) ?? {};
  return format(`${HEADER}${code}\n`, { ...config, parser: "typescript" });
}
