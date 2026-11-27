// @vitest-environment node
// Builds the public player (`vite build --mode player`) into a temporary folder and checks it is
// a static site that works from any sub-path, makes no request to another origin, and carries
// its Content-Security-Policy. Links a visitor can click are allowed; anything the page would
// load or fetch from an absolute http(s) URL fails the test.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAYER_CSP, PLAYER_MODE } from "../../vite.config";
import { EXPORT_DOCS_URL } from "../../src/player/messages";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let outDir = "";

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "orbitrace-player-build-"));
  // Vitest sets NODE_ENV=test, which Vite keeps, giving React's development build. Build as
  // `npm run build:player` does, where NODE_ENV is unset and Vite builds for production.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      configFile: join(packageDir, "vite.config.ts"),
      mode: PLAYER_MODE,
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }
}, 60_000);

afterAll(() => {
  if (outDir !== "") rmSync(outDir, { recursive: true, force: true });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const read = (path: string) => readFileSync(path, "utf8");
const html = () => read(join(outDir, "index.html"));
const byExtension = (extension: string) => files(outDir).filter((path) => path.endsWith(extension));

/**
 * Absolute URLs that appear in the built code but are never requested: XML namespace names
 * (React's DOM code compares element namespaces with them), React's error-page prefix (put into
 * a thrown error's message text), and the docs link a visitor can click.
 */
const NOT_FETCHED = [
  /^http:\/\/www\.w3\.org\/(1998\/Math\/MathML|1999\/xlink|2000\/svg|XML\/1998\/namespace|1999\/xhtml)$/,
  /^https:\/\/react\.dev\/errors\/$/,
];

describe("player build", () => {
  it("writes a static page with its assets, favicon and mark, and no service worker", () => {
    const names = files(outDir).map((path) => relative(outDir, path));
    expect(names).toContain("index.html");
    expect(names).toContain("favicon.svg");
    expect(names).toContain("orbitrace-mark.svg");
    expect(names.some((name) => /^assets\/index-[\w-]+\.js$/.test(name))).toBe(true);
    expect(names.some((name) => /^assets\/demo\.replay-[\w-]+\.js$/.test(name))).toBe(true);
    expect(names.some((name) => /sw\.js$|service-?worker|manifest\.webmanifest$/i.test(name))).toBe(
      false,
    );
    for (const source of byExtension(".js").map(read)) {
      expect(source).not.toMatch(/serviceWorker/);
    }
  });

  it("loads everything with relative URLs and has no inline script or style", () => {
    const page = html();
    const urls = [...page.matchAll(/<(?:script|link|img)\b[^>]*\s(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(urls.length).toBeGreaterThanOrEqual(3);
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(false);
      expect(url).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
    for (const match of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(match[1]).toContain("src=");
      expect((match[2] ?? "").trim()).toBe("");
    }
    expect(page).not.toMatch(/<style\b/);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    for (const source of byExtension(".js").map(read)) {
      expect(source).not.toMatch(/["'`]\/assets\//);
      expect(source).not.toMatch(/\bnew Function\(|\beval\(/);
    }
  });

  it("sets the Content-Security-Policy before any script or style", () => {
    const page = html();
    const meta = `<meta http-equiv="Content-Security-Policy" content="${PLAYER_CSP}" />`;
    expect(page).toContain(meta);
    expect(page.indexOf(meta)).toBeLessThan(page.search(/<script\b|<link\b/));
    expect(PLAYER_CSP).toBe(
      "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(PLAYER_CSP).not.toMatch(/\*|https?:|unsafe-|data:|blob:/);
    expect(page).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("names no absolute http(s) URL that the page would load or fetch", () => {
    const found: string[] = [];
    for (const path of [...byExtension(".html"), ...byExtension(".css"), ...byExtension(".js")]) {
      for (const match of read(path).matchAll(
        /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi,
      )) {
        const url = match[0];
        if (!/^https?:/i.test(url)) {
          // A protocol-relative URL is always a request to another origin.
          found.push(`${relative(outDir, path)}: ${url}`);
          continue;
        }
        if (url === EXPORT_DOCS_URL) continue;
        if (NOT_FETCHED.some((pattern) => pattern.test(url))) continue;
        found.push(`${relative(outDir, path)}: ${url}`);
      }
    }
    expect(found).toEqual([]);
    // The docs link is an anchor the visitor clicks, never a fetch.
    const code = byExtension(".js").map(read).join("\n");
    expect(code).toContain(EXPORT_DOCS_URL);
    for (const css of byExtension(".css").map(read)) {
      expect(css).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
    }
  });

  it("uses no beacon, socket, event stream, cookie or web storage", () => {
    const code = byExtension(".js").map(read).join("\n");
    const used = [
      "sendBeacon",
      "WebSocket",
      "EventSource",
      "document.cookie",
      "localStorage",
      "sessionStorage",
      "indexedDB",
    ].filter((api) => code.includes(api));
    expect(used).toEqual([]);
  });
});
