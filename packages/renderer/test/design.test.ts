import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFORT_LEVELS, KNOWN_MODEL_FAMILIES } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_COLORS,
  DESIGN_FONTS,
  EFFORT_FILL,
  FAMILY_SHAPES,
  INNER_SCALE,
  UNKNOWN_EFFORT_FILL,
  WHITE_CORE,
} from "../src/generated/design.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const designDir = join(packageDir, "..", "..", "design");
const readJson = (name: string) => JSON.parse(readFileSync(join(designDir, name), "utf8"));

describe("generated design module", () => {
  it("is up to date with design/tokens.json and design/model-shapes.json", () => {
    const result = spawnSync(
      process.execPath,
      [join(packageDir, "scripts", "generate-design.mjs"), "--check"],
      {
        encoding: "utf8",
      },
    );
    expect(result.stdout).toContain("up to date");
    expect(result.status).toBe(0);
  });

  it("holds the same colours and fonts as tokens.json", () => {
    const tokens = readJson("tokens.json");
    const flat = Object.assign({}, ...Object.values(tokens.color as Record<string, object>));
    expect(DESIGN_COLORS).toEqual(flat);
    for (const role of Object.keys(tokens.font)) {
      for (const name of tokens.font[role] as string[]) {
        expect(DESIGN_FONTS[role as keyof typeof DESIGN_FONTS]).toContain(name);
      }
    }
  });

  it("holds the same shapes and effort fills as model-shapes.json", () => {
    const shapes = readJson("model-shapes.json");
    for (const [family, def] of Object.entries(
      shapes.families as Record<string, { points: unknown; core: unknown; label: string }>,
    )) {
      const generated = FAMILY_SHAPES[family as keyof typeof FAMILY_SHAPES];
      expect(generated.points).toEqual(def.points);
      expect(generated.core).toEqual(def.core);
      expect(generated.label).toBe(def.label);
    }
    for (const [level, def] of Object.entries(shapes.effort as Record<string, { fill: number }>)) {
      expect(EFFORT_FILL[level as keyof typeof EFFORT_FILL]).toBe(def.fill);
    }
    expect(UNKNOWN_EFFORT_FILL).toBe(shapes.unknownEffortFill);
    expect(INNER_SCALE).toEqual({
      scaleBase: shapes.inner.scaleBase,
      scaleSpan: shapes.inner.scaleSpan,
    });
    expect(WHITE_CORE).toEqual({ color: shapes.whiteCore.color, radius: shapes.whiteCore.radius });
  });

  it("has a shape for every known model family and a fill for every effort level", () => {
    expect(Object.keys(FAMILY_SHAPES).sort()).toEqual([...KNOWN_MODEL_FAMILIES].sort());
    expect(Object.keys(EFFORT_FILL).sort()).toEqual([...EFFORT_LEVELS].sort());
  });
});
