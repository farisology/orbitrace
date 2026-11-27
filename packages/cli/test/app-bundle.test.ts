/**
 * Decision on #76, option (a): the CLI build copies the built web app into dist/app, and
 * `appBundleDir` finds it at run time.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_BUNDLE_FOLDER,
  APP_INDEX_FILE,
  appBundleDir,
  appBundleFolder,
  appIndexReferences,
  checkAppBundle,
} from "../src/app-bundle.js";
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

describe("appBundleFolder", () => {
  it("is the app folder beside the module, whether or not it exists", () => {
    const dir = makeTempDir();
    expect(appBundleFolder(pathToFileURL(join(dir, "index.js")))).toBe(
      join(dir, APP_BUNDLE_FOLDER),
    );
    expect(appBundleFolder().endsWith(join("src", APP_BUNDLE_FOLDER))).toBe(true);
  });
});

describe("appIndexReferences", () => {
  it("keeps relative src and href values, normalised and without duplicates", () => {
    const html = [
      '<link rel="icon" href="favicon.svg">',
      "<script type=\"module\" src='./assets/index-example.js?v=1'></script>",
      '<link rel="stylesheet" href="assets/index-example.css#x">',
      '<script src="./assets/index-example.js"></script>',
      '<a href="../outside.js">x</a>',
    ].join("\n");
    expect(appIndexReferences(html)).toEqual([
      "favicon.svg",
      "assets/index-example.js",
      "assets/index-example.css",
      "../outside.js",
    ]);
  });

  it("skips links to other origins, absolute paths, fragments and empty values", () => {
    const html = [
      '<a href="https://example.com/a.js">',
      '<script src="//example.com/b.js"></script>',
      '<img src="data:image/png;base64,AAAA">',
      '<a href="/root.js">',
      '<a href="#top">',
      '<a href="?q=1">',
      '<a href="">',
      '<a href="./">',
    ].join("\n");
    expect(appIndexReferences(html)).toEqual([]);
  });
});

describe("checkAppBundle", () => {
  it("finds the page and every file it loads", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, APP_INDEX_FILE), '<script src="./assets/a.js"></script>');
    writeFileSync(join(dir, "assets", "a.js"), "");
    expect(checkAppBundle(dir)).toEqual({
      present: true,
      references: ["assets/a.js"],
      missing: [],
    });
  });

  it("names files that are missing or outside the folder, and a missing page", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "assets"));
    writeFileSync(
      join(dir, APP_INDEX_FILE),
      '<script src="./assets/gone.js"></script><link href="../up.css"><link href="assets">',
    );
    expect(checkAppBundle(dir).missing).toEqual(["assets/gone.js", "../up.css", "assets"]);
    expect(checkAppBundle(join(dir, "nothing"))).toEqual({
      present: false,
      references: [],
      missing: [],
    });
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
