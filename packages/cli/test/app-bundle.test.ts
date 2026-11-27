/**
 * Decision on #76, option (a): the CLI build copies the built web app into dist/app, and
 * `appBundleDir` finds it at run time.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { APP_BUNDLE_FOLDER, APP_INDEX_FILE, appBundleDir } from "../src/app-bundle.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("appBundleDir", () => {
  it("returns the app folder beside the module when it has index.html", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, APP_BUNDLE_FOLDER));
    writeFileSync(join(dir, APP_BUNDLE_FOLDER, APP_INDEX_FILE), "<!doctype html>");
    const moduleUrl = pathToFileURL(join(dir, "app-bundle.js"));
    expect(appBundleDir(moduleUrl)).toBe(join(dir, APP_BUNDLE_FOLDER));
    expect(appBundleDir(moduleUrl.href)).toBe(join(dir, APP_BUNDLE_FOLDER));
  });

  it("returns null when there is no app folder or no index.html in it", () => {
    const dir = makeTempDir();
    const moduleUrl = pathToFileURL(join(dir, "app-bundle.js"));
    expect(appBundleDir(moduleUrl)).toBeNull();
    mkdirSync(join(dir, APP_BUNDLE_FOLDER));
    expect(appBundleDir(moduleUrl)).toBeNull();
  });

  it("returns null when run from the sources, which hold no app", () => {
    expect(appBundleDir()).toBeNull();
  });
});

describe("the built CLI", () => {
  // #120: the build bundles every module into dist/index.js, so `appBundleDir` runs from there
  // and the app folder is dist/app beside it. Importing the bundle runs no command.
  const builtModule = new URL("../dist/index.js", import.meta.url);
  const distDir = dirname(fileURLToPath(builtModule));

  it("finds index.html of the web app it was built with, from the bundled layout", async () => {
    const built = (await import(builtModule.href)) as typeof import("../src/index.js");
    const dir = built.appBundleDir();
    expect(dir).toBe(join(distDir, "app"));
    expect(existsSync(join(dir as string, "index.html"))).toBe(true);
    expect(existsSync(join(distDir, "app-bundle.js"))).toBe(false);
  });

  it("carries the app's files but not its type declarations", () => {
    const appDir = join(distDir, "app");
    const sourceDir = fileURLToPath(new URL("../../app/dist", import.meta.url));
    const expected = readdirSync(sourceDir)
      .filter((name) => name !== "types")
      .sort();
    expect(readdirSync(appDir).sort()).toEqual(expected);
    expect(existsSync(join(appDir, "types"))).toBe(false);
  });
});
