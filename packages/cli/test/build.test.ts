/**
 * #120: the build bundles the command and @orbitrace/core into one self-contained ES module,
 * dist/index.js, and ships no source maps and no declarations. #188/#195: core's history worker
 * is bundled as a second, separate file, dist/history-worker.js, beside it. The first block
 * builds small synthetic packages in a temporary folder; the second checks the real build output.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUNDLE_FILE,
  WORKER_EXPORT,
  WORKER_FILE,
  buildCli,
  bundledWorkspaces,
  esbuildOptions,
  resolveWorkerEntry,
  thirdPartyInputs,
} from "../scripts/build.mjs";
import { HISTORY_WORKER_EXPORT } from "@orbitrace/core/node";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

/** Write files (path -> text) under a folder. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The executable bits of a file; Windows has no file modes, so every file counts as executable. */
function executableBits(file: string): number {
  return process.platform === "win32" ? 0o111 : statSync(file).mode & 0o111;
}

/** A synthetic workspace: packages/widget-cli (the package built), packages/app/dist. */
function syntheticWorkspace(files: Record<string, string>): string {
  const root = makeTempDir();
  writeTree(root, {
    "packages/app/dist/index.html": "<!doctype html><title>Synthetic</title>",
    "packages/app/dist/types/index.d.ts": "export {};\n",
    ...files,
  });
  return join(root, "packages", "widget-cli");
}

describe("esbuildOptions", () => {
  it("bundles src/index.ts and the worker into two separate ES modules for Node 20 with no source map", () => {
    const worker = join("/synthetic", "widget-core", "worker.js");
    const options = esbuildOptions("/synthetic/widget-cli", worker);
    expect(options).toMatchObject({
      absWorkingDir: "/synthetic/widget-cli",
      bundle: true,
      splitting: false,
      platform: "node",
      format: "esm",
      target: "node20",
      sourcemap: false,
      metafile: true,
    });
    expect(options.entryPoints).toEqual([
      { in: join("/synthetic/widget-cli", "src", "index.ts"), out: "index" },
      { in: worker, out: "history-worker" },
    ]);
    expect(options.outdir).toBe(join("/synthetic/widget-cli", "dist"));
    expect(join("/synthetic/widget-cli", "dist", "index.js")).toBe(
      join("/synthetic/widget-cli", BUNDLE_FILE),
    );
    expect(join("/synthetic/widget-cli", "dist", "history-worker.js")).toBe(
      join("/synthetic/widget-cli", WORKER_FILE),
    );
    expect(options.external).toBeUndefined();
  });
});

describe("resolveWorkerEntry", () => {
  it("finds core's worker through its package export, by its real path", () => {
    expect(WORKER_EXPORT).toBe(HISTORY_WORKER_EXPORT);
    const packageDir = fileURLToPath(new URL("..", import.meta.url));
    const entry = resolveWorkerEntry(packageDir);
    expect(entry.split(/[\\/]/).slice(-4)).toEqual(["core", "dist", "history", "worker.js"]);
    expect(entry.split(/[\\/]/)).not.toContain("node_modules");
  });

  it("says to build core first when the export cannot be resolved", () => {
    expect(() => resolveWorkerEntry(makeTempDir())).toThrow(/Build @orbitrace\/core first/);
  });
});

describe("thirdPartyInputs and bundledWorkspaces", () => {
  const metafile = {
    inputs: {
      "src/index.ts": {},
      "src/server/link.ts": {},
      "../core/dist/index.js": {},
      "../core/dist/sources/node.js": {},
      "../../node_modules/widget-lib/index.js": {},
      "node_modules/other-lib/main.js": {},
    },
  };

  it("lists the inputs that come from a node_modules folder", () => {
    expect(thirdPartyInputs(metafile)).toEqual([
      "../../node_modules/widget-lib/index.js",
      "node_modules/other-lib/main.js",
    ]);
    expect(thirdPartyInputs({ inputs: { "src\\index.ts": {} } })).toEqual([]);
    expect(thirdPartyInputs({ inputs: { "..\\..\\node_modules\\x\\a.js": {} } })).toHaveLength(1);
  });

  it("names each workspace package the bundle took code from", () => {
    expect(bundledWorkspaces(metafile)).toEqual(["cli", "core"]);
    expect(bundledWorkspaces({ inputs: {} })).toEqual([]);
  });
});

describe("buildCli (synthetic packages)", () => {
  it("writes one executable bundle with the shebang and the worker beside it, inlines workspace code and copies the app", async () => {
    const dir = syntheticWorkspace({
      "packages/widget-cli/src/index.ts":
        '#!/usr/bin/env node\nimport { greet } from "../../widget-core/greet.js";\nimport { join } from "node:path";\nexport const line: string = greet(join("a", "b"));\n',
      "packages/widget-core/greet.js": "export function greet(name) { return `hello ${name}`; }\n",
      "packages/widget-core/worker.js":
        'import { parentPort } from "node:worker_threads";\nimport { greet } from "./greet.js";\nparentPort?.postMessage(greet("worker-marker"));\n',
      "packages/widget-cli/dist/stale.js.map": "{}",
    });
    const workerEntry = join(dir, "..", "widget-core", "worker.js");
    const result = await buildCli(dir, { workerEntry });
    expect(result.appFiles).toBe(1);
    expect(result.workspaces).toEqual(["cli", "widget-core"]);
    const bundle = readFileSync(join(dir, BUNDLE_FILE), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(bundle).toContain("hello ");
    expect(bundle).toMatch(/from "node:path"/);
    expect(bundle).not.toContain("sourceMappingURL");
    expect(bundle).not.toContain("worker-marker");
    const worker = readFileSync(join(dir, WORKER_FILE), "utf8");
    expect(worker).toContain("worker-marker");
    expect(worker).toContain("hello ");
    expect(worker.startsWith("#!")).toBe(false);
    expect(readdirSync(join(dir, "dist")).sort()).toEqual(["app", "history-worker.js", "index.js"]);
    expect(readdirSync(join(dir, "dist", "app"))).toEqual(["index.html"]);
    expect(executableBits(join(dir, BUNDLE_FILE))).toBe(0o111);
  });

  it("refuses to bundle code from a third-party package", async () => {
    const dir = syntheticWorkspace({
      "packages/widget-cli/src/index.ts":
        'import { shout } from "widget-lib";\nexport const line: string = shout("x");\n',
      "packages/widget-cli/node_modules/widget-lib/package.json": JSON.stringify({
        name: "widget-lib",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
      "packages/widget-cli/node_modules/widget-lib/index.js":
        "export function shout(text) { return text.toUpperCase(); }\n",
    });
    await expect(buildCli(dir, { workerEntry: join(dir, "src", "index.ts") })).rejects.toThrow(
      /third-party packages were bundled/,
    );
    expect(existsSync(join(dir, "dist", "app"))).toBe(false);
  });

  it("fails when the web app is not built", async () => {
    const root = makeTempDir();
    writeTree(root, { "packages/widget-cli/src/index.ts": "export const x = 1;\n" });
    const dir = join(root, "packages", "widget-cli");
    await expect(buildCli(dir, { workerEntry: join(dir, "src", "index.ts") })).rejects.toThrow(
      /web app is not built/,
    );
  });
});

describe("the real build output", () => {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  const distDir = join(packageDir, "dist");
  const bundlePath = join(packageDir, BUNDLE_FILE);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    main: string;
    types?: string;
    files: string[];
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("declares no run-time dependency, so npm fetches nothing when it installs the tarball", () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.devDependencies).toHaveProperty("@orbitrace/core");
    expect(manifest.bin).toEqual({ orbitrace: "./dist/index.js" });
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBeUndefined();
    expect(manifest.files).toEqual(["dist/index.js", "dist/history-worker.js", "dist/app"]);
  });

  it("is the command and its history worker beside the app, with no source maps or declarations", () => {
    expect(readdirSync(distDir).sort()).toEqual(["app", "history-worker.js", "index.js"]);
    const all = readdirSync(distDir, { recursive: true, encoding: "utf8" });
    expect(all.filter((name) => name.endsWith(".map") || name.endsWith(".d.ts"))).toEqual([]);
  });

  /** The module specifiers a bundle imports. */
  const importsOf = (code: string): string[] =>
    [
      ...code.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm),
      ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1] as string);
  const builtins = new Set(builtinModules);
  const foreignOf = (specifiers: readonly string[]): string[] =>
    specifiers.filter((specifier) => !specifier.startsWith("node:") && !builtins.has(specifier));

  it("starts with the shebang, is executable and imports only Node built-ins", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(executableBits(bundlePath)).toBe(0o111);
    const specifiers = importsOf(bundle);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(foreignOf(specifiers)).toEqual([]);
    expect(bundle).not.toContain("@orbitrace/");
    expect(bundle).not.toContain("sourceMappingURL");
  });

  it("ships the worker as its own file, importing only Node built-ins, and finds it beside itself", () => {
    const worker = readFileSync(join(packageDir, WORKER_FILE), "utf8");
    expect(foreignOf(importsOf(worker))).toEqual([]);
    expect(importsOf(worker)).toContain("node:worker_threads");
    expect(worker).not.toContain("@orbitrace/");
    expect(worker).not.toContain("sourceMappingURL");
    // The worker's code is not inlined into the command; the command names the file instead.
    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle).toContain("history-worker.js");
    expect(worker).toContain("isMainThread");
    expect(bundle).not.toContain("isMainThread");
  });
});
