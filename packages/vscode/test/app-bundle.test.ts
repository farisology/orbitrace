import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_BUNDLE_SEGMENTS,
  APP_INDEX_FILE,
  APP_MISSING_MESSAGE,
  appBundleDir,
  readAppIndex,
} from "../src/app-bundle.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("appBundleDir", () => {
  it("is dist/app below the extension folder", () => {
    expect(APP_BUNDLE_SEGMENTS).toEqual(["dist", "app"]);
    expect(appBundleDir(join("/", "workspace", "ext"))).toBe(
      join("/", "workspace", "ext", "dist", "app"),
    );
  });
});

describe("readAppIndex", () => {
  it("reads index.html from the app folder", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, APP_INDEX_FILE), "<!doctype html>");
    expect(readAppIndex(dir)).toBe("<!doctype html>");
  });

  it("throws a path-free message when the app is missing or unreadable", () => {
    const dir = makeTempDir();
    expect(() => readAppIndex(join(dir, "missing"))).toThrow(APP_MISSING_MESSAGE);
    mkdirSync(join(dir, "folder", APP_INDEX_FILE), { recursive: true });
    expect(() => readAppIndex(join(dir, "folder"))).toThrow(APP_MISSING_MESSAGE);
    expect(APP_MISSING_MESSAGE).not.toContain(dir);
  });
});
