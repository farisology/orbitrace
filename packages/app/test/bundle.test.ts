// @vitest-environment node
// Builds the app into a temporary folder and checks it can be served from any folder, an editor
// webview resource URI included, under a strict Content-Security-Policy: every URL relative, no
// absolute `/assets` path, no inline script or style, no eval.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let outDir = "";

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "orbitrace-app-bundle-"));
  await build({
    root: packageDir,
    configFile: join(packageDir, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
}, 60_000);

afterAll(() => {
  if (outDir !== "") rmSync(outDir, { recursive: true, force: true });
});

const scripts = () =>
  readdirSync(join(outDir, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(outDir, "assets", name), "utf8"));

describe("built bundle", () => {
  it("loads its script and styles with relative URLs and has no inline script or style", () => {
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const urls = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(urls.length).toBeGreaterThanOrEqual(3);
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(false);
      expect(url).not.toMatch(/^[a-z]+:/i);
    }
    expect(urls.some((url) => url.startsWith("./assets/") && url.endsWith(".js"))).toBe(true);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(match[1]).toContain("src=");
      expect((match[2] ?? "").trim()).toBe("");
    }
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("loads chunks relative to itself and never by an absolute /assets path", () => {
    const code = scripts();
    expect(code.length).toBeGreaterThanOrEqual(2);
    for (const source of code) {
      expect(source).not.toMatch(/["'`]\/assets\//);
      expect(source).not.toMatch(/\bnew Function\(|\beval\(/);
    }
    expect(code.some((source) => /\.\/demo\.replay-[\w-]+\.js/.test(source))).toBe(true);
  });
});
