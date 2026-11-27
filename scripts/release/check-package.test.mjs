// Tests for scripts/release/lib.mjs, check-package.mjs and sync-licenses.mjs.
// Synthetic trees are written into temporary folders that each test removes. Planted private
// strings are assembled at run time from fragments, so this file holds no literal match for the
// privacy check. The last block packs the real core, renderer and cli (after `npm run build`).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMachineLiterals,
  checkArtefact,
  checkBins,
  checkContents,
  checkManifest,
  checkPaths,
  checkSelfContained,
  checkSourceMaps,
  checkThirdPartyNotices,
  entryPoints,
  formatReport,
  moduleSpecifiers,
  packAndCheck,
  readWorkspaceIndex,
  webBundleDirs,
} from "./check-package.mjs";
import * as appNotices from "../../packages/app/scripts/third-party-notices.mjs";
import * as cliCopy from "../../packages/cli/scripts/copy-app.mjs";
import * as vscodeCopy from "../../packages/vscode/scripts/copy-app.mjs";
import {
  DENIED_PATHS,
  NPM_PACKAGES,
  VSIX_PACKAGE,
  REPO_GIT_URL,
  REPO_ROOT,
  REPO_URL,
  extractTarball,
  formatSize,
  globToRegExp,
  isInside,
  listTree,
  packNpm,
  sha256File,
} from "./lib.mjs";
import { licenseCopies, syncLicenses } from "./sync-licenses.mjs";

const LICENSE_TEXT = "MIT License\n\nSynthetic licence text for tests.\n";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbitrace-release-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write files (path -> text) under a folder. */
function writeTree(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A manifest that passes every metadata check for the package folder `name`. */
function goodManifest(dirName, overrides = {}) {
  return {
    name: `@orbitrace/${dirName}`,
    version: "1.2.3",
    description: "Synthetic package for tests.",
    license: "MIT",
    repository: { type: "git", url: REPO_GIT_URL, directory: `packages/${dirName}` },
    homepage: `${REPO_URL}/tree/main/packages/${dirName}#readme`,
    bugs: { url: `${REPO_URL}/issues` },
    files: ["dist"],
    ...overrides,
  };
}

const SPEC = {
  dir: "widget",
  name: "@orbitrace/widget",
  allow: ["package.json", "README.md", "LICENSE", "dist/**/*.js", "dist/**/*.d.ts"],
  require: ["README.md", "LICENSE"],
};

describe("globToRegExp", () => {
  it("keeps * inside one folder and lets **/ cross folders, including none", () => {
    const pattern = globToRegExp("dist/**/*.js");
    expect(pattern.test("dist/a.js")).toBe(true);
    expect(pattern.test("dist/x/y/a.js")).toBe(true);
    expect(pattern.test("dist/a.js.map")).toBe(false);
    expect(pattern.test("src/a.js")).toBe(false);
    expect(globToRegExp("dist/*.js").test("dist/x/a.js")).toBe(false);
  });

  it("treats every other character as literal", () => {
    expect(globToRegExp("[Content_Types].xml").test("[Content_Types].xml")).toBe(true);
    expect(globToRegExp("[Content_Types].xml").test("C.xml")).toBe(false);
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
    expect(globToRegExp("file?.txt").test("file1.txt")).toBe(true);
  });
});

describe("lib helpers", () => {
  it("lists a tree with sizes, sorted, with forward slashes", () => {
    writeTree(dir, { "b.txt": "12", "a/c.txt": "1234" });
    expect(listTree(dir)).toEqual([
      { path: "a/c.txt", size: 4 },
      { path: "b.txt", size: 2 },
    ]);
  });

  it("hashes a file with SHA-256", () => {
    writeTree(dir, { "x.txt": "abc" });
    expect(sha256File(join(dir, "x.txt"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("tells whether a path is inside a folder", () => {
    expect(isInside(dir, dir)).toBe(true);
    expect(isInside(dir, join(dir, "a", "b"))).toBe(true);
    expect(isInside(dir, join(dir, "..", "elsewhere"))).toBe(false);
    expect(isInside(join(dir, "a"), join(dir, "ab"))).toBe(false);
    expect(isInside(join(dir, "a"), join(dir, "..a"))).toBe(false);
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KiB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.00 MiB");
  });

  it("denies tests, fixtures, transcripts and build files whatever the allow-list says", () => {
    const denied = (path) => DENIED_PATHS.some((rule) => rule.pattern.test(path));
    expect(denied("dist/test/a.js")).toBe(true);
    expect(denied("dist/a.test.js")).toBe(true);
    expect(denied("fixtures/config/x.json")).toBe(true);
    expect(denied("dist/session.jsonl")).toBe(true);
    expect(denied("tsconfig.build.json")).toBe(true);
    expect(denied(".env.local")).toBe(true);
    expect(denied("dist/app/assets/demo.replay-abc.js")).toBe(false);
    expect(denied("dist/index.js")).toBe(false);
  });

  it("packs a package folder with npm pack and unpacks the tarball", () => {
    const packageDir = join(dir, "pkg");
    writeTree(packageDir, {
      "package.json": JSON.stringify({
        name: "synthetic-widget",
        version: "0.0.1",
        files: ["dist"],
      }),
      "dist/index.js": "export const x = 1;\n",
      "src/index.ts": "export const x = 1;\n",
    });
    const dest = join(dir, "out");
    mkdirSync(dest);
    const packed = packNpm(packageDir, dest);
    expect(packed.filename).toBe("synthetic-widget-0.0.1.tgz");
    expect(existsSync(packed.path)).toBe(true);
    const unpacked = extractTarball(packed.path, mkdtempSync(join(dir, "x-")));
    expect(listTree(unpacked).map((file) => file.path)).toEqual(["dist/index.js", "package.json"]);
  });
});

describe("checkPaths", () => {
  it("accepts allowed files and names each file that is not allowed or denied", () => {
    const errors = checkPaths(
      ["package.json", "dist/index.js", "dist/index.js.map", "src/index.ts", "dist/x.test.js"],
      SPEC.allow,
    );
    expect(errors).toEqual([
      "dist/index.js.map: not in the allow-list",
      "src/index.ts: not in the allow-list",
      "dist/x.test.js: not allowed in a published artefact (test-file)",
    ]);
  });
});

describe("entryPoints", () => {
  it("collects main, types, bin and export targets, without wildcards", () => {
    expect(
      entryPoints({
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        bin: { tool: "./dist/cli.js" },
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./node": { default: "./dist/node.js" },
          "./dist/*": "./dist/*",
        },
      }),
    ).toEqual(["dist/cli.js", "dist/index.d.ts", "dist/index.js", "dist/node.js"]);
  });
});

describe("checkManifest", () => {
  const workspaces = new Map([
    ["@orbitrace/core", { version: "1.2.3", private: false }],
    ["@orbitrace/app", { version: "1.2.3", private: true }],
  ]);

  it("passes a complete manifest", () => {
    expect(checkManifest(goodManifest("widget"), SPEC, workspaces)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("reports missing repository, homepage, bugs, files and a wrong licence", () => {
    const manifest = goodManifest("widget", { license: "ISC", homepage: undefined, files: [] });
    delete manifest.repository;
    delete manifest.bugs;
    const { errors } = checkManifest(manifest, SPEC, workspaces);
    expect(errors).toHaveLength(5);
    expect(errors.join("\n")).toMatch(/license is not MIT/);
    expect(errors.join("\n")).toMatch(/repository must be/);
    expect(errors.join("\n")).toMatch(/homepage is not/);
    expect(errors.join("\n")).toMatch(/bugs\.url/);
    expect(errors.join("\n")).toMatch(/no files allow-list/);
  });

  it("rejects a repository without the package folder", () => {
    const manifest = goodManifest("widget", { repository: { type: "git", url: REPO_GIT_URL } });
    expect(checkManifest(manifest, SPEC, workspaces).errors).toHaveLength(1);
  });

  it("rejects a dependency on a private workspace or on another version", () => {
    const manifest = goodManifest("widget", {
      dependencies: { "@orbitrace/app": "1.2.3", "@orbitrace/core": "^1.0.0", other: "^2.0.0" },
    });
    expect(checkManifest(manifest, SPEC, workspaces).errors).toEqual([
      "package.json: depends on @orbitrace/app, a private workspace package",
      "package.json: depends on @orbitrace/core@^1.0.0; workspace packages share one version",
    ]);
  });

  it("warns about a private package", () => {
    const manifest = goodManifest("widget", { private: true });
    expect(checkManifest(manifest, SPEC, workspaces).warnings).toHaveLength(1);
  });
});

describe("checkSourceMaps", () => {
  it("accepts maps whose sources are shipped or embedded", () => {
    writeTree(dir, {
      "dist/a.js": "x\n//# sourceMappingURL=a.js.map\n",
      "dist/a.js.map": JSON.stringify({ version: 3, sources: ["../src/a.ts"] }),
      "src/a.ts": "x",
      "dist/b.js": "y\n//# sourceMappingURL=b.js.map\n",
      "dist/b.js.map": JSON.stringify({
        version: 3,
        sources: ["../src/b.ts"],
        sourcesContent: ["y"],
      }),
      "dist/c.js": "z\n//# sourceMappingURL=data:application/json;base64,e30=\n",
    });
    const paths = new Set(listTree(dir).map((file) => file.path));
    expect(checkSourceMaps(dir, paths)).toEqual([]);
  });

  it("reports a map that points at an unshipped source and a comment that points at no map", () => {
    writeTree(dir, {
      "dist/a.js": "x\n//# sourceMappingURL=a.js.map\n",
      "dist/a.js.map": JSON.stringify({ version: 3, sources: ["../src/a.ts"] }),
      "dist/b.d.ts": "export {};\n//# sourceMappingURL=b.d.ts.map\n",
      "dist/c.js.map": JSON.stringify({ version: 3, sources: ["file:///abs/c.ts"] }),
      "dist/d.js.map": "not json",
    });
    const paths = new Set(listTree(dir).map((file) => file.path));
    expect(checkSourceMaps(dir, paths)).toEqual([
      "dist/a.js.map: points at src/a.ts, which is not shipped",
      "dist/b.d.ts: sourceMappingURL points at dist/b.d.ts.map, which is not shipped",
      "dist/c.js.map: source 0 is not a relative path inside the package",
      "dist/d.js.map: not a valid source map",
    ]);
  });
});

describe("moduleSpecifiers", () => {
  it("finds static, side-effect and dynamic imports and require calls, in order", () => {
    const text = [
      "#!/usr/bin/env node",
      'import { a } from "node:fs";',
      "import {",
      "  b,",
      "  c",
      "} from 'widget-lib/sub';",
      'import "./side.js";',
      'export { d } from "../d.js";',
      'export * from "@scope/pkg";',
      'const e = await import("./lazy.js");',
      'const f = require("os");',
      'const g = requireFromHere("../package.json");',
      'const text = "import x from y";',
      "",
    ].join("\n");
    expect(moduleSpecifiers(text)).toEqual([
      "node:fs",
      "widget-lib/sub",
      "./side.js",
      "../d.js",
      "@scope/pkg",
      "./lazy.js",
      "os",
    ]);
  });
});

describe("checkSelfContained", () => {
  const files = {
    "package.json": "{}",
    "dist/index.js":
      'import { a } from "node:fs";\nimport { b } from "path";\nimport "./chunk.js";\n',
    "dist/chunk.js": "export {};\n",
  };

  it("accepts Node built-ins and shipped files with no dependencies", () => {
    writeTree(dir, files);
    const paths = new Set(listTree(dir).map((file) => file.path));
    expect(checkSelfContained(dir, paths, ["dist/*.js"], { devDependencies: { x: "1" } })).toEqual(
      [],
    );
  });

  it("reports dependencies, foreign packages, unshipped files and path-like imports", () => {
    writeTree(dir, {
      ...files,
      "dist/index.js": [
        'import { a } from "@orbitrace/core";',
        'import { b } from "@orbitrace/core";',
        'import "./missing.js";',
        'const c = await import("/synthetic/abs/x.js");',
        'const d = require("widget-lib");',
        "",
      ].join("\n"),
    });
    const paths = new Set(listTree(dir).map((file) => file.path));
    const errors = checkSelfContained(dir, paths, ["dist/index.js"], {
      dependencies: { "@orbitrace/core": "1.0.0" },
      peerDependencies: { widget: "1" },
      optionalDependencies: {},
    });
    expect(errors).toEqual([
      "package.json: declares 1 dependencies; a self-contained package installs with none",
      "package.json: declares 1 peerDependencies; a self-contained package installs with none",
      "dist/index.js: imports @orbitrace/core, which is not inside the tarball",
      "dist/index.js: imports dist/missing.js, which is not shipped",
      "dist/index.js: imports a module that is neither a Node.js built-in nor shipped",
      "dist/index.js: imports widget-lib, which is not inside the tarball",
    ]);
    expect(errors.join("\n")).not.toContain("synthetic/abs");
  });

  it("reports globs that match no file", () => {
    writeTree(dir, files);
    const paths = new Set(listTree(dir).map((file) => file.path));
    expect(checkSelfContained(dir, paths, ["bin/*.js"], {})).toEqual([
      "no file matches the self-contained globs",
    ]);
  });
});

describe("checkBins", () => {
  it("accepts an executable bin file with the node shebang", () => {
    writeTree(dir, { "dist/cli.js": "#!/usr/bin/env node\nexport {};\n" });
    chmodSync(join(dir, "dist", "cli.js"), 0o755);
    expect(checkBins(dir, { bin: { tool: "./dist/cli.js" } }, "linux")).toEqual([]);
    expect(checkBins(dir, { bin: "./dist/cli.js" }, "linux")).toEqual([]);
    expect(checkBins(dir, {}, "linux")).toEqual([]);
  });

  it("reports a bin without the shebang or without the executable bit, and skips missing ones", () => {
    writeTree(dir, { "dist/cli.js": "export {};\n" });
    chmodSync(join(dir, "dist", "cli.js"), 0o644);
    const manifest = { bin: { tool: "./dist/cli.js", other: "./dist/missing.js" } };
    expect(checkBins(dir, manifest, "linux")).toEqual([
      "dist/cli.js: a bin file must start with #!/usr/bin/env node",
      "dist/cli.js: a bin file must be executable",
    ]);
    expect(checkBins(dir, manifest, "win32")).toEqual([
      "dist/cli.js: a bin file must start with #!/usr/bin/env node",
    ]);
  });
});

describe("checkContents", () => {
  it("reports privacy findings and build-machine folders without printing them", () => {
    const home = "/" + "home/" + "synthetic-person";
    const repo = join(dir, "synthetic-repo-root");
    writeTree(dir, {
      "dist/a.js": `const where = "${home}/x";\n`,
      "dist/b.js": `const built = ${JSON.stringify(repo)};\n`,
      "dist/c.js": "const fine = 1;\n",
      "dist/d.bin": `${home}\n`,
    });
    const errors = checkContents(
      dir,
      ["dist/a.js", "dist/b.js", "dist/c.js", "dist/d.bin"],
      [repo],
    );
    expect(errors).toEqual([
      "dist/a.js:1: privacy rule home-path-linux",
      "dist/b.js: contains a folder path of the build machine",
    ]);
    expect(errors.join("\n")).not.toContain("synthetic-person");
  });

  it("names the repository and home folders as build-machine strings", () => {
    expect(buildMachineLiterals("/synthetic/root")).toContain("/synthetic/root");
    expect(buildMachineLiterals()).toHaveLength(2);
  });
});

describe("checkArtefact", () => {
  it("passes a clean tree and fails a changed licence, an empty README and a missing file", () => {
    writeTree(dir, {
      "package.json": "{}",
      "README.md": "# widget\n",
      LICENSE: LICENSE_TEXT,
      "dist/index.js": "export {};\n",
    });
    const options = { licenseText: LICENSE_TEXT, licensePath: "LICENSE", literals: [] };
    const clean = checkArtefact(dir, SPEC, { ...options, extraRequired: ["dist/index.js"] });
    expect(clean.errors).toEqual([]);
    expect(clean.files.map((file) => file.path)).toEqual([
      "LICENSE",
      "README.md",
      "dist/index.js",
      "package.json",
    ]);

    writeTree(dir, { LICENSE: "Another licence\n", "README.md": "  \n" });
    const broken = checkArtefact(dir, SPEC, { ...options, extraRequired: ["dist/missing.js"] });
    expect(broken.errors).toEqual([
      "dist/missing.js: missing",
      "LICENSE: differs from the repository LICENSE",
      "README.md: empty",
    ]);
  });
});

describe("third-party notices (#143)", () => {
  const NOTICES = "THIRD-PARTY-NOTICES.txt";
  const LIST = "third-party-modules.json";
  /** A module list as the app build writes it. */
  const moduleList = {
    format: 1,
    notices: NOTICES,
    packages: [
      { name: "@synthetic/helper", version: "2.0.0", license: "ISC" },
      { name: "widget-lib", version: "1.0.0", license: "MIT" },
    ],
    chunks: {
      "assets/data-0000.js": [],
      "assets/index-0000.js": ["@synthetic/helper@2.0.0", "widget-lib@1.0.0"],
    },
  };
  const notices = (...ids) =>
    `Synthetic notices\n\n${ids.map((id) => `Package: ${id}\nLicence: MIT\n\nText.\n`).join("\n")}`;
  /** A CLI-like artefact: dist/app holds the web app bundle with its notices and module list. */
  const bundleTree = (extra = {}) => ({
    "package.json": "{}",
    "dist/index.js": "export {};\n",
    "dist/app/index.html": "<!doctype html>",
    "dist/app/favicon.svg": "<svg/>",
    "dist/app/assets/index-0000.js": "x",
    "dist/app/assets/data-0000.js": "x",
    "dist/app/assets/index-0000.css": "x",
    [`dist/app/${NOTICES}`]: notices("widget-lib@1.0.0", "@synthetic/helper@2.0.0"),
    [`dist/app/${LIST}`]: JSON.stringify(moduleList),
    ...extra,
  });
  const pathsOf = (root) => new Set(listTree(root).map((file) => file.path));

  it("uses the file names of the app build and of both copy steps", () => {
    expect(appNotices.NOTICES_FILE).toBe(NOTICES);
    expect(appNotices.MODULE_LIST_FILE).toBe(LIST);
    expect(cliCopy.NOTICES_FILE).toBe(NOTICES);
    expect(vscodeCopy.NOTICES_FILE).toBe(NOTICES);
  });

  it("accepts the notices and the module list in the CLI and .vsix allow-lists", () => {
    const cli = NPM_PACKAGES.find((spec) => spec.dir === "cli");
    expect(checkPaths([`dist/app/${NOTICES}`, `dist/app/${LIST}`], cli?.allow ?? [])).toEqual([]);
    expect(
      checkPaths(
        [`extension/dist/app/${NOTICES}`, `extension/dist/app/${LIST}`],
        VSIX_PACKAGE.allow,
      ),
    ).toEqual([]);
    expect(checkPaths([`dist/${NOTICES}`], cli?.allow ?? [])).toEqual([
      `dist/${NOTICES}: not in the allow-list`,
    ]);
  });

  it("finds the folders that hold a web app bundle", () => {
    expect(
      webBundleDirs(
        new Set([
          "index.html",
          "assets/a.js",
          "extension/dist/app/index.html",
          "extension/dist/app/assets/b.js",
          "docs/index.html",
          "docs/assets/c.css",
          "lib/assets/d.js",
        ]),
      ),
    ).toEqual(["", "extension/dist/app"]);
    expect(webBundleDirs(new Set(["dist/index.js", "README.md"]))).toEqual([]);
  });

  it("passes notices that name exactly the bundled packages, and ignores artefacts without the app", () => {
    writeTree(dir, bundleTree());
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toEqual([]);
    const library = join(dir, "library");
    writeTree(library, { "package.json": "{}", "dist/index.js": "export {};\n" });
    expect(checkThirdPartyNotices(library, pathsOf(library))).toEqual([]);
  });

  it("fails an artefact that carries the web bundle without the notices", () => {
    writeTree(dir, bundleTree());
    rmSync(join(dir, "dist", "app", NOTICES));
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toEqual([
      `dist/app/${NOTICES}: missing; the web app bundle beside it contains third-party code`,
    ]);
  });

  it("fails notices that do not name a package found in the bundle's module list", () => {
    writeTree(dir, bundleTree({ [`dist/app/${NOTICES}`]: notices("widget-lib@1.0.0") }));
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toEqual([
      `dist/app/${NOTICES}: does not name @synthetic/helper@2.0.0, which is in the bundle`,
    ]);
  });

  it("fails stale notices: an extra package, or a bundle from another build", () => {
    const extra = notices("widget-lib@1.0.0", "@synthetic/helper@2.0.0", "widget-lib@0.9.0");
    writeTree(dir, bundleTree({ [`dist/app/${NOTICES}`]: extra }));
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toEqual([
      `dist/app/${NOTICES}: names widget-lib@0.9.0, which is not in the bundle (stale)`,
    ]);
    writeTree(dir, { "dist/app/assets/index-1111.js": "x" });
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toEqual([
      `dist/app/assets/index-1111.js: not in dist/app/${LIST}; the bundle and the list come from different builds`,
    ]);
  });

  it("fails a missing or unreadable module list", () => {
    writeTree(dir, bundleTree());
    rmSync(join(dir, "dist", "app", LIST));
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toEqual([
      `dist/app/${LIST}: missing; the notices beside it cannot be checked without it`,
    ]);
    writeTree(dir, { [`dist/app/${LIST}`]: JSON.stringify({ format: 99 }) });
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toEqual([
      `dist/app/${LIST}: not a format 1 module list`,
    ]);
    writeTree(dir, { [`dist/app/${LIST}`]: "not json" });
    expect(checkThirdPartyNotices(dir, pathsOf(dir))).toHaveLength(1);
  });

  it("runs as part of checkArtefact", () => {
    writeTree(dir, bundleTree({ "README.md": "# widget\n", LICENSE: LICENSE_TEXT }));
    const spec = NPM_PACKAGES.find((entry) => entry.dir === "cli") ?? SPEC;
    const options = { licenseText: LICENSE_TEXT, licensePath: "LICENSE", literals: [] };
    expect(checkArtefact(dir, spec, options).errors).toEqual([]);
    rmSync(join(dir, "dist", "app", NOTICES));
    expect(checkArtefact(dir, spec, options).errors).toEqual([
      `dist/app/${NOTICES}: missing; the web app bundle beside it contains third-party code`,
    ]);
  });
});

describe("readWorkspaceIndex and formatReport", () => {
  it("indexes every workspace manifest with its version and private flag", () => {
    writeTree(dir, {
      "packages/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
      "packages/b/package.json": JSON.stringify({ name: "b", version: "1.0.0", private: true }),
      "packages/notes/readme.txt": "no manifest here",
    });
    expect([...readWorkspaceIndex(dir)]).toEqual([
      ["a", { version: "1.0.0", private: false }],
      ["b", { version: "1.0.0", private: true }],
    ]);
  });

  it("prints one block per artefact with its files, warnings and errors", () => {
    const text = formatReport([
      {
        name: "widget",
        file: "widget-1.0.0.tgz",
        size: 2048,
        files: [{ path: "package.json", size: 100 }],
        errors: ["x: missing"],
        warnings: ["private"],
      },
    ]);
    expect(text).toContain("widget  widget-1.0.0.tgz  2.0 KiB packed, 100 B unpacked, 1 files");
    expect(text).toContain("  warning: private");
    expect(text).toContain("  error: x: missing");
    expect(text).toContain("  1 error(s)");
  });
});

describe("LICENSE copies", () => {
  it("copies the licence into each package and the check finds no difference afterwards", () => {
    writeTree(dir, { LICENSE: LICENSE_TEXT });
    for (const spec of NPM_PACKAGES)
      mkdirSync(join(dir, "packages", spec.dir), { recursive: true });
    const copies = licenseCopies(dir);
    expect(syncLicenses(copies, { check: true })).toHaveLength(NPM_PACKAGES.length);
    expect(syncLicenses(copies)).toHaveLength(NPM_PACKAGES.length);
    expect(syncLicenses(copies, { check: true })).toEqual([]);
    expect(readFileSync(join(dir, "packages", "core", "LICENSE"), "utf8")).toBe(LICENSE_TEXT);
  });

  it("the committed copies match the repository LICENSE", () => {
    expect(syncLicenses(licenseCopies(REPO_ROOT), { check: true })).toEqual([]);
  });
});

const built = NPM_PACKAGES.every((spec) =>
  existsSync(join(REPO_ROOT, "packages", spec.dir, "dist", "index.js")),
);

// `npm test` at the root builds every package first, so this runs in CI.
describe.skipIf(!built)("the real tarballs (after npm run build)", () => {
  it(
    "packs core, renderer and cli with no errors and the expected contents",
    { timeout: 120_000 },
    () => {
      const workspaces = readWorkspaceIndex(REPO_ROOT);
      const reports = NPM_PACKAGES.map((spec) =>
        packAndCheck(spec, { destDir: dir, workDir: dir, workspaces }),
      );
      expect(reports.flatMap((report) => report.errors.map((e) => `${report.name}: ${e}`))).toEqual(
        [],
      );
      for (const report of reports) {
        const paths = report.files.map((file) => file.path);
        expect(paths).toContain("LICENSE");
        expect(paths).toContain("README.md");
      }
      const [core, renderer, cli] = reports;
      for (const library of [core, renderer]) {
        expect(library.files.some((file) => file.path.endsWith(".map"))).toBe(false);
        expect(library.files.some((file) => file.path.startsWith("src/"))).toBe(false);
      }
      expect(core.files.map((file) => file.path)).toContain("schema/replay-v1.schema.json");
      // #120: the CLI is one bundle beside the web app: no src, no maps, no declarations.
      const cliPaths = cli.files.map((file) => file.path);
      expect(cliPaths).toContain("dist/app/index.html");
      expect(cliPaths.filter((path) => !path.startsWith("dist/app/"))).toEqual([
        "LICENSE",
        "README.md",
        "dist/index.js",
        "package.json",
      ]);
      // #143: the notices and the build's module list travel beside the web app.
      expect(cliPaths).toContain("dist/app/THIRD-PARTY-NOTICES.txt");
      expect(cliPaths).toContain("dist/app/third-party-modules.json");
    },
  );
});
