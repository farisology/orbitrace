// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_GOLDEN_REPLAY_PATH } from "@orbitrace/fixtures";
import { validateReplay } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import { DEMO } from "./helpers";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const designDir = join(packageDir, "..", "..", "design");

describe("copied assets", () => {
  it("are up to date with their sources", () => {
    const result = spawnSync(
      process.execPath,
      [join(packageDir, "scripts", "sync-assets.mjs"), "--check"],
      {
        encoding: "utf8",
      },
    );
    expect(result.stdout).not.toContain("OUT OF DATE");
    expect(result.status).toBe(0);
  });

  it("are reported out of date when a copy differs or is missing", async () => {
    // @ts-expect-error -- plain ES module script without type declarations
    const { ASSETS, isUpToDate, expected } = await import("../scripts/sync-assets.mjs");
    const dir = mkdtempSync(join(tmpdir(), "orbitrace-app-sync-"));
    try {
      const tokens = ASSETS.find((a: { target: string }) => a.target.endsWith("tokens.css"));
      const target = join(dir, "tokens.css");
      const asset = { ...tokens, target };
      expect(await isUpToDate(asset)).toBe(false);
      writeFileSync(target, await expected(asset));
      expect(await isUpToDate(asset)).toBe(true);
      writeFileSync(target, ":root { --void: red; }\n");
      expect(await isUpToDate(asset)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bundle the demo golden replay unchanged, and it validates", () => {
    expect(DEMO).toEqual(JSON.parse(readFileSync(DEMO_GOLDEN_REPLAY_PATH, "utf8")));
    expect(validateReplay(DEMO)).toBe(true);
  });

  it("carry every design token", () => {
    const tokens = JSON.parse(readFileSync(join(designDir, "tokens.json"), "utf8"));
    const css = readFileSync(
      join(packageDir, "src", "generated", "tokens.css"),
      "utf8",
    ).toLowerCase();
    for (const group of Object.values(tokens.color as Record<string, Record<string, string>>)) {
      for (const [name, value] of Object.entries(group)) {
        expect(css).toContain(`--${name}: ${value.toLowerCase()};`);
      }
    }
  });
});

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("colours", () => {
  it("are written only in the generated token file", () => {
    const colour = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
    const offenders = filesUnder(join(packageDir, "src"))
      .filter((path) => !path.includes(`${join("src", "generated")}`))
      .filter((path) => /\.(tsx?|css)$/.test(path))
      .filter((path) => colour.test(readFileSync(path, "utf8")))
      .map((path) => relative(packageDir, path));
    expect(offenders).toEqual([]);
  });
});
