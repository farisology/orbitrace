// @vitest-environment node
// Tests for scripts/third-party-notices.mjs (#143). Synthetic packages are written into
// temporary folders; the last block builds the real app twice with its Vite config.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_LICENSES,
  GENERATED_CODE_NOTE,
  MODULE_LIST_FILE,
  NOTICES_FILE,
  PACKAGE_HEADING,
  VIRTUAL_PROVIDERS,
  classifyModule,
  collectBundle,
  compareCodePoints,
  findPackageDir,
  isLicenseAllowed,
  licenseExpression,
  ownLicenseText,
  packageOfPath,
  parseModuleList,
  parseNoticedPackages,
  readBundledPackage,
  renderModuleList,
  renderNotices,
  thirdPartyNotices,
} from "./third-party-notices.mjs";

const MIT_TEXT =
  "MIT License\n\nCopyright (c) Synthetic Widget Authors\n\nPermission is granted.\n";

let dir = "";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-notices-")));
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

/** A synthetic installed package under `root`. */
function writePackage(root, name, manifest, files = { LICENSE: MIT_TEXT }) {
  const tree = { "package.json": JSON.stringify({ name, version: "1.0.0", ...manifest }) };
  writeTree(join(root, "node_modules", ...name.split("/")), { ...tree, ...files, "index.js": "" });
  return join(root, "node_modules", ...name.split("/"));
}

/** A synthetic repository: repo/packages/widget-app, with packages installed at the root. */
function syntheticRepo() {
  const repoRoot = join(dir, "repo");
  const appDir = join(repoRoot, "packages", "widget-app");
  writeTree(appDir, { "src/main.js": "export {};\n" });
  return { repoRoot, appDir };
}

describe("compareCodePoints and packageOfPath", () => {
  it("sorts by code point, independent of locale", () => {
    expect(["b", "B", "a-b", "a@b", "a"].sort(compareCodePoints)).toEqual([
      "B",
      "a",
      "a-b",
      "a@b",
      "b",
    ]);
  });

  it("finds the package after the last node_modules, scoped or not", () => {
    const root = join(sep, "work");
    expect(packageOfPath(join(root, "node_modules", "widget-lib", "cjs", "a.js"))).toEqual({
      name: "widget-lib",
      dir: join(root, "node_modules", "widget-lib"),
    });
    expect(packageOfPath(join(root, "node_modules", "@synthetic", "pkg", "index.js"))).toEqual({
      name: "@synthetic/pkg",
      dir: join(root, "node_modules", "@synthetic", "pkg"),
    });
    const nested = join(root, "node_modules", "outer", "node_modules", "inner", "x.js");
    expect(packageOfPath(nested)?.name).toBe("inner");
    expect(packageOfPath(join(root, "packages", "core", "dist", "index.js"))).toBeNull();
    expect(packageOfPath(join(root, "node_modules", "@synthetic"))).toBeNull();
  });
});

describe("findPackageDir", () => {
  it("looks in node_modules of the folder and of each parent", () => {
    const { repoRoot, appDir } = syntheticRepo();
    const installed = writePackage(repoRoot, "widget-lib", {});
    expect(findPackageDir("widget-lib", appDir)).toBe(installed);
    expect(findPackageDir("missing-lib", appDir)).toBeNull();
  });
});

describe("classifyModule", () => {
  it("treats repository files outside node_modules as first-party, linked workspaces included", () => {
    const { repoRoot, appDir } = syntheticRepo();
    const options = { repoRoot, appDir };
    expect(classifyModule(join(appDir, "src", "main.js"), options)).toEqual({
      kind: "first-party",
    });
    writeTree(repoRoot, { "packages/widget-core/dist/index.js": "export {};\n" });
    mkdirSync(join(repoRoot, "node_modules", "@synthetic"), { recursive: true });
    symlinkSync(
      join(repoRoot, "packages", "widget-core"),
      join(repoRoot, "node_modules", "@synthetic", "widget-core"),
      "junction",
    );
    const linked = join(repoRoot, "node_modules", "@synthetic", "widget-core", "dist", "index.js");
    expect(classifyModule(`${linked}?query`, options)).toEqual({ kind: "first-party" });
  });

  it("attributes node_modules files and known virtual modules to their package", () => {
    const { repoRoot, appDir } = syntheticRepo();
    const options = { repoRoot, appDir };
    const lib = writePackage(repoRoot, "widget-lib", {});
    expect(classifyModule(join(lib, "index.js"), options)).toEqual({ kind: "package", dir: lib });
    const vite = writePackage(repoRoot, "vite", {});
    const rolldown = writePackage(vite, "rolldown", {});
    expect(classifyModule("\0vite/preload-helper.js", options)).toEqual({
      kind: "package",
      dir: vite,
    });
    expect(classifyModule("\0rolldown/runtime.js", options)).toEqual({
      kind: "package",
      dir: rolldown,
    });
    expect(VIRTUAL_PROVIDERS.map((provider) => provider.name)).toEqual(["vite", "rolldown"]);
  });

  it("refuses modules it cannot attribute", () => {
    const { repoRoot, appDir } = syntheticRepo();
    const options = { repoRoot, appDir };
    expect(() => classifyModule("\0synthetic-plugin/helper.js", options)).toThrow(
      /unknown provider \("synthetic-plugin"\)/,
    );
    expect(() => classifyModule("\0vite/preload-helper.js", options)).toThrow(/not installed/);
    expect(() => classifyModule("relative/module.js", options)).toThrow(/neither a file path/);
    const outside = join(dir, "elsewhere", "module.js");
    expect(() => classifyModule(outside, options)).toThrow(/outside both/);
    try {
      classifyModule(outside, options);
    } catch (error) {
      expect(String(error)).not.toContain(dir);
    }
  });
});

describe("licences", () => {
  it("reads the licence from license, a { type } object or the old licenses array", () => {
    expect(licenseExpression({ license: " MIT " })).toBe("MIT");
    expect(licenseExpression({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseExpression({ licenses: [{ type: "MIT" }] })).toBe("MIT");
    expect(licenseExpression({ licenses: ["MIT", { type: "Apache-2.0" }] })).toBe(
      "(MIT OR Apache-2.0)",
    );
    expect(licenseExpression({ license: "" })).toBeNull();
    expect(licenseExpression({})).toBeNull();
  });

  it("allows one allowed id, an OR with one allowed, or an AND with all allowed", () => {
    expect(ALLOWED_LICENSES).toEqual([
      "0BSD",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "MIT",
    ]);
    expect(isLicenseAllowed("MIT")).toBe(true);
    expect(isLicenseAllowed("(MIT OR GPL-3.0-only)")).toBe(true);
    expect(isLicenseAllowed("MIT AND ISC")).toBe(true);
    expect(isLicenseAllowed("MIT AND GPL-3.0-only")).toBe(false);
    expect(isLicenseAllowed("GPL-3.0-only")).toBe(false);
    expect(isLicenseAllowed("Apache-2.0 WITH LLVM-exception")).toBe(false);
    expect(isLicenseAllowed("(MIT OR (ISC AND BSD-3-Clause))")).toBe(false);
    expect(isLicenseAllowed("MIT OR ISC AND BSD-3-Clause")).toBe(false);
    expect(isLicenseAllowed("SEE LICENSE IN LICENSE.txt")).toBe(false);
    expect(isLicenseAllowed("WTFPL", ["WTFPL"])).toBe(true);
  });

  it("keeps a licence file's own part and drops a bundled-dependencies section", () => {
    const tool =
      "# Tool licence\r\nMIT License\r\n\r\n# Licenses of bundled dependencies\r\nother\r\n";
    expect(ownLicenseText(`\uFEFF${tool}`)).toEqual({
      text: "# Tool licence\nMIT License",
      trimmed: true,
    });
    expect(ownLicenseText(MIT_TEXT)).toEqual({ text: MIT_TEXT.trimEnd(), trimmed: false });
    expect(ownLicenseText("# Licenses of bundled dependencies\nall of it\n").trimmed).toBe(false);
  });
});

describe("readBundledPackage", () => {
  it("reads name, version, licence and every licence file, sorted", () => {
    const pkg = writePackage(
      dir,
      "widget-lib",
      { license: "MIT" },
      {
        LICENSE: MIT_TEXT,
        "THIRD-PARTY-LICENSE": "Derived code: synthetic notice.\n",
        "LICENSE-MIT": MIT_TEXT,
        "README.md": "# widget\n",
      },
    );
    const info = readBundledPackage(pkg);
    expect(info.name).toBe("widget-lib");
    expect(info.version).toBe("1.0.0");
    expect(info.license).toBe("MIT");
    expect(info.files.map((file) => file.file)).toEqual([
      "LICENSE",
      "LICENSE-MIT",
      "THIRD-PARTY-LICENSE",
    ]);
    expect(info.files[0]?.text).toBe(MIT_TEXT.trimEnd());
  });

  it("copies the NOTICE file of an Apache-2.0 package", () => {
    const pkg = writePackage(
      dir,
      "apache-lib",
      { license: "Apache-2.0" },
      {
        "LICENSE.txt": "Apache License\nVersion 2.0\n",
        NOTICE: "Synthetic Apache notice.\n",
      },
    );
    expect(readBundledPackage(pkg).files.map((file) => file.file)).toEqual([
      "LICENSE.txt",
      "NOTICE",
    ]);
  });

  it("fails without a licence file, without a licence, or with a licence outside the allow-list", () => {
    const bare = writePackage(dir, "bare-lib", { license: "MIT" }, { "README.md": "x" });
    expect(() => readBundledPackage(bare)).toThrow(/bare-lib@1\.0\.0 has no licence file/);
    const silent = writePackage(dir, "silent-lib", {});
    expect(() => readBundledPackage(silent)).toThrow(/silent-lib@1\.0\.0 declares no licence/);
    const copyleft = writePackage(dir, "copyleft-lib", { license: "GPL-3.0-only" });
    expect(() => readBundledPackage(copyleft)).toThrow(
      /copyleft-lib@1\.0\.0 is licensed GPL-3\.0-only, which is not in the allow-list/,
    );
    const nameless = writePackage(dir, "nameless-lib", { name: undefined, license: "MIT" });
    expect(() => readBundledPackage(nameless)).toThrow(/no name or version/);
  });
});

describe("collectBundle, renderNotices and the module list", () => {
  function bundleFixture() {
    const { repoRoot, appDir } = syntheticRepo();
    const zeta = writePackage(repoRoot, "zeta-lib", { license: "MIT" });
    const alpha = writePackage(repoRoot, "@synthetic/alpha", { license: "ISC", version: "2.0.0" });
    const unused = writePackage(repoRoot, "unused-lib", { license: "GPL-3.0-only" });
    const chunks = [
      {
        fileName: "assets/main-0000.js",
        modules: [
          { id: join(zeta, "index.js"), renderedLength: 10 },
          { id: join(appDir, "src", "main.js"), renderedLength: 10 },
          { id: join(alpha, "index.js"), renderedLength: 3 },
          { id: join(zeta, "index.js"), renderedLength: 10 },
          // Tree-shaken to nothing: its licence is never read.
          { id: join(unused, "index.js"), renderedLength: 0 },
        ],
      },
      {
        fileName: "assets/data-0000.js",
        modules: [{ id: join(appDir, "src", "main.js"), renderedLength: 5 }],
      },
    ];
    return { chunks, options: { repoRoot, appDir } };
  }

  it("lists each package once, sorted, and the packages of each chunk", () => {
    const { chunks, options } = bundleFixture();
    const bundle = collectBundle(chunks, options);
    expect(bundle.packages.map((pkg) => `${pkg.name}@${pkg.version} ${pkg.license}`)).toEqual([
      "@synthetic/alpha@2.0.0 ISC",
      "zeta-lib@1.0.0 MIT",
    ]);
    expect(bundle.chunks).toEqual({
      "assets/data-0000.js": [],
      "assets/main-0000.js": ["@synthetic/alpha@2.0.0", "zeta-lib@1.0.0"],
    });
    expect(Object.keys(bundle.chunks)).toEqual(["assets/data-0000.js", "assets/main-0000.js"]);
  });

  it("renders the same notices whatever the module order, with one heading per package", () => {
    const { chunks, options } = bundleFixture();
    const text = renderNotices(collectBundle(chunks, options).packages);
    const reversed = chunks.map((chunk) => ({ ...chunk, modules: [...chunk.modules].reverse() }));
    expect(renderNotices(collectBundle(reversed.reverse(), options).packages)).toBe(text);
    expect([...parseNoticedPackages(text)]).toEqual(["@synthetic/alpha@2.0.0", "zeta-lib@1.0.0"]);
    expect(text).toContain(
      "Packages (2):\n  @synthetic/alpha@2.0.0 (ISC)\n  zeta-lib@1.0.0 (MIT)\n",
    );
    expect(text).toContain(
      `${PACKAGE_HEADING}zeta-lib@1.0.0\nLicence: MIT\nFrom: LICENSE\n\n${MIT_TEXT}`,
    );
    expect(text).toContain(GENERATED_CODE_NOTE);
    expect(text).not.toContain(dir);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("says so when no third-party code is bundled", () => {
    const text = renderNotices([]);
    expect(text).toContain("No third-party package code is in this bundle.");
    expect(text).toContain(GENERATED_CODE_NOTE);
    expect(parseNoticedPackages(text).size).toBe(0);
  });

  it("notes a trimmed licence file", () => {
    const text = renderNotices([
      {
        name: "tool",
        version: "1.0.0",
        license: "MIT",
        files: [{ file: "LICENSE.md", text: "MIT License", trimmed: true }],
      },
    ]);
    expect(text).toContain("From: LICENSE.md, the package's own licence only. Its \"Licenses of");
  });

  it("writes a module list that parses back, and refuses one that does not", () => {
    const { chunks, options } = bundleFixture();
    const bundle = collectBundle(chunks, options);
    const list = parseModuleList(renderModuleList(bundle));
    expect(list.format).toBe(1);
    expect(list.chunks).toEqual(bundle.chunks);
    expect(list.packages).toEqual([
      { name: "@synthetic/alpha", version: "2.0.0", license: "ISC" },
      { name: "zeta-lib", version: "1.0.0", license: "MIT" },
    ]);
    expect(() => parseModuleList('{"format":2,"packages":[],"chunks":{}}')).toThrow(/format 1/);
    expect(() => parseModuleList('{"format":1,"packages":[],"chunks":{"a.js":[1]}}')).toThrow(
      /format 1/,
    );
    expect(() => parseModuleList("null")).toThrow(/format 1/);
  });

  it("reads heading lines with Windows line endings", () => {
    expect([...parseNoticedPackages("x\r\nPackage: a@1.0.0\r\nPackage: b@2.0.0 \r\n")]).toEqual([
      "a@1.0.0",
      "b@2.0.0",
    ]);
  });
});

describe("thirdPartyNotices (the Vite plugin)", () => {
  /** Run the plugin's generateBundle with a fake plugin context. */
  function run(plugin, bundle) {
    const emitted = [];
    const context = {
      emitFile: (file) => emitted.push(file),
      error: (message) => {
        throw new Error(message);
      },
    };
    plugin.generateBundle.call(context, {}, bundle);
    return emitted;
  }

  it("emits the notices and, for the app build, the module list", () => {
    const { repoRoot, appDir } = syntheticRepo();
    const lib = writePackage(repoRoot, "widget-lib", { license: "MIT" });
    const bundle = {
      "assets/index-0000.js": {
        type: "chunk",
        fileName: "assets/index-0000.js",
        moduleIds: [join(lib, "index.js"), join(appDir, "src", "main.js")],
        modules: {
          [join(lib, "index.js")]: { renderedLength: 4 },
          [join(appDir, "src", "main.js")]: { renderedLength: 4 },
        },
      },
      "assets/index-0000.css": { type: "asset", fileName: "assets/index-0000.css" },
    };
    const plugin = thirdPartyNotices({ repoRoot, appDir, moduleList: true });
    expect(plugin.name).toBe("orbitrace-third-party-notices");
    expect(plugin.apply).toBe("build");
    const emitted = run(plugin, bundle);
    expect(emitted.map((file) => file.fileName)).toEqual([NOTICES_FILE, MODULE_LIST_FILE]);
    expect(emitted[0]?.source).toContain("Package: widget-lib@1.0.0");
    expect(JSON.parse(emitted[1]?.source ?? "").chunks).toEqual({
      "assets/index-0000.js": ["widget-lib@1.0.0"],
    });
    const player = thirdPartyNotices({ repoRoot, appDir, moduleList: false });
    expect(run(player, bundle).map((file) => file.fileName)).toEqual([NOTICES_FILE]);
  });

  it("fails the build when a bundled package breaks a rule", () => {
    const { repoRoot, appDir } = syntheticRepo();
    const lib = writePackage(repoRoot, "copyleft-lib", { license: "GPL-3.0-only" });
    const plugin = thirdPartyNotices({ repoRoot, appDir, moduleList: true });
    const bundle = {
      "assets/index-0000.js": {
        type: "chunk",
        fileName: "assets/index-0000.js",
        moduleIds: [join(lib, "index.js")],
      },
    };
    expect(() => run(plugin, bundle)).toThrow(
      /^third-party notices: copyleft-lib@1\.0\.0 is licensed GPL-3\.0-only/,
    );
  });
});

describe("the real app build", () => {
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

  /** Build the app with its own Vite config into a new temporary folder. */
  async function buildApp(mode) {
    const { build } = await import("vite");
    const outDir = join(dir, `out-${mode}-${readdirSync(dir).length}`);
    await build({
      // The player config sets its own root (src/player); an inline root would override it.
      ...(mode === "player" ? {} : { root: appDir }),
      configFile: join(appDir, "vite.config.ts"),
      mode,
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
    return outDir;
  }

  /** The installed version of a package the app depends on. */
  function installed(name) {
    const found = findPackageDir(name, appDir);
    if (found === null) throw new Error(`${name} is not installed`);
    return JSON.parse(readFileSync(join(found, "package.json"), "utf8")).version;
  }

  it(
    "writes the same notices on every build, naming every package in the module list",
    { timeout: 120_000 },
    async () => {
      const first = await buildApp("production");
      const second = await buildApp("production");
      const notices = readFileSync(join(first, NOTICES_FILE), "utf8");
      expect(readFileSync(join(second, NOTICES_FILE), "utf8")).toBe(notices);
      expect(readFileSync(join(second, MODULE_LIST_FILE), "utf8")).toBe(
        readFileSync(join(first, MODULE_LIST_FILE), "utf8"),
      );

      const list = parseModuleList(readFileSync(join(first, MODULE_LIST_FILE), "utf8"));
      const scripts = readdirSync(join(first, "assets"))
        .filter((name) => name.endsWith(".js"))
        .map((name) => `assets/${name}`)
        .sort(compareCodePoints);
      expect(Object.keys(list.chunks)).toEqual(scripts);
      const bundled = new Set(Object.values(list.chunks).flat());
      expect([...parseNoticedPackages(notices)].sort(compareCodePoints)).toEqual(
        [...bundled].sort(compareCodePoints),
      );
      for (const name of ["react", "react-dom", "scheduler"]) {
        expect(bundled).toContain(`${name}@${installed(name)}`);
      }
      expect(list.packages.every((pkg) => ALLOWED_LICENSES.includes(pkg.license))).toBe(true);
      expect(notices).toContain(GENERATED_CODE_NOTE);
      expect(notices).not.toContain(appDir);
    },
  );

  it(
    "writes the notices but no module list into the player build",
    { timeout: 120_000 },
    async () => {
      const out = await buildApp("player");
      const files = readdirSync(out);
      expect(files).toContain(NOTICES_FILE);
      expect(files).not.toContain(MODULE_LIST_FILE);
      expect(readFileSync(join(out, NOTICES_FILE), "utf8")).toContain(
        `Package: react@${installed("react")}`,
      );
    },
  );
});
