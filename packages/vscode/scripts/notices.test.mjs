// Tests for the third-party guards of scripts/build.mjs and scripts/copy-app.mjs (#143): the
// extension bundle takes no code from a third-party package (checked from esbuild's metafile),
// the app's notices file and module list travel with the copied web app.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertFirstPartyOnly, esbuildOptions, thirdPartyInputs } from "./build.mjs";
import { NOTICES_FILE, copyAppBundle, noticesProblem } from "./copy-app.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbitrace-vscode-notices-"));
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

describe("thirdPartyInputs and assertFirstPartyOnly", () => {
  const metafile = {
    inputs: {
      "src/extension.ts": {},
      "../core/dist/index.js": {},
      "../../node_modules/widget-lib/index.js": {},
      "node_modules\\other-lib\\main.js": {},
    },
  };

  it("lists the inputs that come from a node_modules folder", () => {
    expect(thirdPartyInputs(metafile)).toEqual([
      "../../node_modules/widget-lib/index.js",
      "node_modules\\other-lib\\main.js",
    ]);
    expect(thirdPartyInputs({ inputs: { "src/extension.ts": {} } })).toEqual([]);
  });

  it("throws only when a third-party file was bundled", () => {
    expect(() => assertFirstPartyOnly(metafile)).toThrow(
      /2 file\(s\) from third-party packages were bundled into dist\/extension\.js/,
    );
    expect(() => assertFirstPartyOnly({ inputs: { "../core/dist/index.js": {} } })).not.toThrow();
  });

  it("asks esbuild for a metafile", () => {
    expect(esbuildOptions(packageDir).metafile).toBe(true);
  });

  it("finds only first-party code in the real extension bundle", { timeout: 60_000 }, async () => {
    const options = { ...esbuildOptions(packageDir), outfile: join(dir, "extension.js") };
    const result = await build(options);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((path) => path.startsWith("src/"))).toBe(true);
    expect(inputs.some((path) => path.startsWith("../core/"))).toBe(true);
    expect(thirdPartyInputs(result.metafile)).toEqual([]);
  });
});

describe("copyAppBundle, noticesProblem and the notices", () => {
  it("copies THIRD-PARTY-NOTICES.txt and the module list", () => {
    const source = join(dir, "app-dist");
    writeTree(source, {
      "index.html": "<!doctype html>",
      "assets/index-0000.js": "console.log(1)",
      [NOTICES_FILE]: "Package: widget-lib@1.0.0\n",
      "third-party-modules.json": "{}",
    });
    const target = join(dir, "ext", "dist", "app");
    expect(copyAppBundle(source, target)).toEqual([
      NOTICES_FILE,
      "assets/index-0000.js",
      "index.html",
      "third-party-modules.json",
    ]);
    expect(noticesProblem(target)).toBeNull();
  });

  it("reports script bundles without the notices, naming no folder", () => {
    writeTree(dir, { "app/index.html": "x", "app/assets/a.js": "x" });
    const problem = noticesProblem(join(dir, "app"));
    expect(problem).toMatch(/1 script file\(s\) but no THIRD-PARTY-NOTICES\.txt/);
    expect(problem).not.toContain(dir);
    expect(noticesProblem(join(dir, "nothing"))).toBeNull();
  });
});

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
