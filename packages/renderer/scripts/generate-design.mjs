#!/usr/bin/env node
// Generates src/generated/design.ts from the repository's design files.
//
//   node scripts/generate-design.mjs          write src/generated/design.ts
//   node scripts/generate-design.mjs --check  write nothing; exit 1 if the file is out of date
//
// Sources (read at generation time only; the renderer never imports them at run time):
//   design/tokens.json        colours and font stacks
//   design/model-shapes.json  node polygon per model family, effort fill fractions
//
// The output is formatted with the repository's Prettier config, and the check compares
// Prettier-formatted text, so `npm run format` never makes the check fail.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const designDir = resolve(packageDir, "..", "..", "design");
export const OUTPUT_FILE = join(packageDir, "src", "generated", "design.ts");

/** CSS font stack, quoted the same way as design/scripts/build-tokens.mjs. */
function fontStack(list) {
  return list.map((f) => (/^[a-z-]+$/.test(f) ? f : `"${f}"`)).join(", ");
}

/**
 * Build the TypeScript source for the design module.
 * @param {any} tokens parsed design/tokens.json
 * @param {any} shapes parsed design/model-shapes.json
 * @returns {string}
 */
export function buildDesignSource(tokens, shapes) {
  const colors = {};
  for (const group of Object.values(tokens.color)) Object.assign(colors, group);
  const fonts = {};
  for (const [role, list] of Object.entries(tokens.font)) fonts[role] = fontStack(list);
  const families = {};
  for (const [name, def] of Object.entries(shapes.families)) {
    families[name] = { label: def.label, shape: def.shape, points: def.points, core: def.core };
  }
  const effort = {};
  for (const [name, def] of Object.entries(shapes.effort)) effort[name] = def.fill;

  const json = (value) => JSON.stringify(value, null, 2);
  return [
    "// Generated from design/tokens.json and design/model-shapes.json by",
    "// packages/renderer/scripts/generate-design.mjs. Do not edit by hand: run `npm run generate`",
    "// in packages/renderer. test/design.test.ts fails when this file is out of date.",
    "",
    "/** Every colour token, flattened from its group. */",
    `export const DESIGN_COLORS = ${json(colors)} as const;`,
    "",
    "/** CSS font stacks by role. */",
    `export const DESIGN_FONTS = ${json(fonts)} as const;`,
    "",
    "/** Node outline per model family, for radius 1 centred on (0, 0), y down. `null` points: circle. */",
    `export const FAMILY_SHAPES = ${json(families)} as const;`,
    "",
    "/** Inner fill fraction per effort level. */",
    `export const EFFORT_FILL = ${json(effort)} as const;`,
    "",
    "/** Fill used when the effort is not recorded. */",
    `export const UNKNOWN_EFFORT_FILL = ${json(shapes.unknownEffortFill)};`,
    "",
    "/** The inner shape is the outer shape scaled by `scaleBase + scaleSpan * fill`. */",
    `export const INNER_SCALE = ${json({ scaleBase: shapes.inner.scaleBase, scaleSpan: shapes.inner.scaleSpan })} as const;`,
    "",
    "/** White dot drawn at max effort, at the family's core point. */",
    `export const WHITE_CORE = ${json({ color: shapes.whiteCore.color, radius: shapes.whiteCore.radius })} as const;`,
    "",
  ].join("\n");
}

async function prettify(source) {
  const config = (await resolveConfig(OUTPUT_FILE)) ?? {};
  return format(source, { ...config, filepath: OUTPUT_FILE });
}

/** Read the design files and return the formatted module text. */
export async function generate() {
  const tokens = JSON.parse(readFileSync(join(designDir, "tokens.json"), "utf8"));
  const shapes = JSON.parse(readFileSync(join(designDir, "model-shapes.json"), "utf8"));
  return prettify(buildDesignSource(tokens, shapes));
}

/** True when the file on disk says the same as a fresh generation. */
export async function isUpToDate() {
  let current;
  try {
    current = readFileSync(OUTPUT_FILE, "utf8");
  } catch {
    return false;
  }
  const expected = await generate();
  return (await prettify(current)) === expected;
}

async function main() {
  if (process.argv.includes("--check")) {
    const ok = await isUpToDate();
    console.log(ok ? "up to date  src/generated/design.ts" : "OUT OF DATE src/generated/design.ts");
    process.exitCode = ok ? 0 : 1;
    return;
  }
  writeFileSync(OUTPUT_FILE, await generate());
  console.log("wrote       src/generated/design.ts");
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
