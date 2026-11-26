import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ASSETS, syncAssets } from "../scripts/sync-assets.mjs";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("ASSETS", () => {
  it("copies the activity-bar icon and the licence", () => {
    const targets = ASSETS.map((asset) => asset.target.split(/[\\/]/).slice(-2).join("/"));
    expect(targets).toEqual(["media/activity-bar.svg", "vscode/LICENSE"]);
  });

  it("committed copies match their sources (sync check)", () => {
    expect(syncAssets(ASSETS, { check: true })).toEqual([]);
  });

  it("the activity-bar icon is monochrome: it only uses currentColor", () => {
    const svg = readFileSync(ASSETS[0]?.target as string, "utf8");
    expect(svg).toContain("currentColor");
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});

describe("syncAssets", () => {
  it("writes missing or different copies and reports them", () => {
    const dir = makeTempDir();
    const source = join(dir, "source.svg");
    writeFileSync(source, "<svg/>");
    const assets = [{ source, target: join(dir, "out", "copy.svg") }];
    expect(syncAssets(assets)).toEqual([join(dir, "out", "copy.svg")]);
    expect(readFileSync(join(dir, "out", "copy.svg"), "utf8")).toBe("<svg/>");
    expect(syncAssets(assets)).toEqual([]);
  });

  it("only reports in check mode", () => {
    const dir = makeTempDir();
    const source = join(dir, "source.svg");
    writeFileSync(source, "<svg/>");
    const target = join(dir, "copy.svg");
    expect(syncAssets([{ source, target }], { check: true })).toEqual([target]);
    expect(existsSync(target)).toBe(false);
    writeFileSync(target, "<svg>old</svg>");
    expect(syncAssets([{ source, target }], { check: true })).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe("<svg>old</svg>");
  });

  it("throws when a source is missing", () => {
    const dir = makeTempDir();
    expect(() => syncAssets([{ source: join(dir, "none"), target: join(dir, "t") }])).toThrow(
      /missing/,
    );
  });
});
