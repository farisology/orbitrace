// Tests for the third-party notices steps of scripts/copy-app.mjs and scripts/build.mjs (#143):
// the app's notices file and module list travel with the copied web app, and the build fails
// when the copied app has script bundles but no notices.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCli } from "./build.mjs";
import { NOTICES_FILE, SKIPPED_ENTRIES, copyAppBundle, noticesProblem } from "./copy-app.mjs";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbitrace-cli-notices-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write files (path -> text) under a folder.
 * @param {string} root
 * @param {Record<string, string>} files
 */
function writeTree(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

describe("copyAppBundle and the notices", () => {
  it("copies THIRD-PARTY-NOTICES.txt and the module list, and leaves the types out", () => {
    const source = join(dir, "app-dist");
    writeTree(source, {
      "index.html": "<!doctype html>",
      "assets/index-0000.js": "console.log(1)",
      [NOTICES_FILE]: "Package: widget-lib@1.0.0\n",
      "third-party-modules.json": "{}",
      "types/index.d.ts": "export {};",
    });
    expect(NOTICES_FILE).toBe("THIRD-PARTY-NOTICES.txt");
    expect(SKIPPED_ENTRIES).toEqual(["types"]);
    const target = join(dir, "cli-dist", "app");
    expect(copyAppBundle(source, target)).toEqual([
      NOTICES_FILE,
      "assets/index-0000.js",
      "index.html",
      "third-party-modules.json",
    ]);
    expect(noticesProblem(target)).toBeNull();
  });
});

describe("noticesProblem", () => {
  it("accepts an app without script bundles, or one with the notices beside them", () => {
    writeTree(dir, { "plain/index.html": "x", "plain/assets/index.css": "x" });
    expect(noticesProblem(join(dir, "plain"))).toBeNull();
    expect(noticesProblem(join(dir, "missing"))).toBeNull();
  });

  it("reports script bundles without the notices, naming no folder", () => {
    writeTree(dir, { "app/index.html": "x", "app/assets/a.js": "x", "app/assets/b.js": "x" });
    const problem = noticesProblem(join(dir, "app"));
    expect(problem).toMatch(/2 script file\(s\) but no THIRD-PARTY-NOTICES\.txt/);
    expect(problem).not.toContain(dir);
  });
});

describe("buildCli and the notices", () => {
  it("fails when the built app has script bundles but no notices", async () => {
    writeTree(dir, {
      "packages/app/dist/index.html": "<!doctype html>",
      "packages/app/dist/assets/index-0000.js": "console.log(1)",
      "packages/widget-cli/src/index.ts": "export const x = 1;\n",
    });
    await expect(buildCli(join(dir, "packages", "widget-cli"))).rejects.toThrow(
      /but no THIRD-PARTY-NOTICES\.txt/,
    );
  });

  it("copies the notices beside the app when they are there", async () => {
    writeTree(dir, {
      "packages/app/dist/index.html": "<!doctype html>",
      "packages/app/dist/assets/index-0000.js": "console.log(1)",
      [`packages/app/dist/${NOTICES_FILE}`]: "Package: widget-lib@1.0.0\n",
      "packages/app/dist/third-party-modules.json": "{}",
      "packages/widget-cli/src/index.ts": "export const x = 1;\n",
    });
    const result = await buildCli(join(dir, "packages", "widget-cli"));
    expect(result.appFiles).toBe(4);
    const app = join(dir, "packages", "widget-cli", "dist", "app");
    expect(readdirSync(app).sort()).toEqual([
      NOTICES_FILE,
      "assets",
      "index.html",
      "third-party-modules.json",
    ]);
  });
});

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = existsSync(join(packageDir, "dist", "app", "index.html"));

// `npm test` at the root builds every package first, so this runs in CI.
describe.skipIf(!built)("the real build output (after npm run build)", () => {
  it("carries the notices and the module list beside the web app", () => {
    const app = join(packageDir, "dist", "app");
    expect(existsSync(join(app, NOTICES_FILE))).toBe(true);
    expect(existsSync(join(app, "third-party-modules.json"))).toBe(true);
    expect(noticesProblem(app)).toBeNull();
  });
});
