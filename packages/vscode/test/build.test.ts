/**
 * Checks the build output that `npm run build` (run by `npm test` at the root) leaves in dist/:
 * one CommonJS bundle that loads in Node with `vscode` supplied by the host, and the web app
 * copied beside it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { esbuildOptions } from "../scripts/build.mjs";
import * as vscodeFake from "./fakes/vscode.js";
import { fakeReplayer, removeTempDirs } from "./helpers.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = join(packageDir, "..", "..");
const bundle = join(packageDir, "dist", "extension.js");

afterAll(() => {
  removeTempDirs();
});

beforeEach(() => {
  vscodeFake.fake.reset();
});

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesBelow(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

type LoadHook = (request: string, parent: unknown, isMain: boolean) => unknown;

/** `require` the built bundle with `vscode` answered by the fake, as the extension host would. */
function requireBundle(): { activate: (...args: unknown[]) => void; deactivate: () => void } {
  const loader = Module as unknown as { _load: LoadHook };
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === "vscode") return vscodeFake;
    return original.call(this, request, parent, isMain);
  };
  try {
    const load = createRequire(import.meta.url);
    delete load.cache[bundle];
    return load(bundle);
  } finally {
    loader._load = original;
  }
}

describe("esbuildOptions", () => {
  it("bundles one CommonJS file for Node 20 with vscode external and no source maps", () => {
    const options = esbuildOptions(packageDir);
    expect(options).toMatchObject({
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["vscode"],
      sourcemap: false,
    });
    expect(options.outfile).toBe(bundle);
    expect(options.entryPoints).toEqual([join(packageDir, "src", "extension.ts")]);
  });
});

describe("the built extension", () => {
  it("is one CommonJS file that requires vscode and nothing from node_modules", () => {
    const code = readFileSync(bundle, "utf8");
    expect(code).toContain('require("vscode")');
    const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(required.filter((name) => name !== "vscode" && !name?.startsWith("node:"))).toEqual([]);
    expect(code).not.toContain(repoDir);
    expect(code).not.toContain("sourceMappingURL");
  });

  it("loads in Node, activates, and opens the copied app in a tab", async () => {
    const started = performance.now();
    const extension = requireBundle();
    const context = {
      subscriptions: [] as { dispose(): unknown }[],
      extensionUri: vscodeFake.Uri.file(packageDir),
    };
    extension.activate(context, { replayer: fakeReplayer([]) });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(typeof extension.deactivate).toBe("function");

    await vscodeFake.commands.executeCommand("orbitrace.openDemo");
    const panel = vscodeFake.fake.panels[0];
    expect(panel?.webview.html).toContain("Content-Security-Policy");
    expect(panel?.webview.html).toMatch(/src="\.\/assets\/index-[^"]+\.js"/);
    for (const item of context.subscriptions) item.dispose();
  });

  it("carries the web app in dist/app, without type declarations or source maps", () => {
    const appDir = join(packageDir, "dist", "app");
    expect(existsSync(join(appDir, "index.html"))).toBe(true);
    expect(existsSync(join(appDir, "types"))).toBe(false);
    const files = filesBelow(join(packageDir, "dist")).map((file) => relative(packageDir, file));
    expect(files.filter((file) => file.endsWith(".map"))).toEqual([]);
    expect(files.filter((file) => file.endsWith(".d.ts"))).toEqual([]);
    expect(statSync(bundle).size).toBeLessThan(2_000_000);
  });
});
