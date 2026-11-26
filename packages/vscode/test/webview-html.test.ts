import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWebviewHtml,
  contentSecurityPolicy,
  cspSourceTokens,
  escapeAttribute,
  headElements,
} from "../src/webview-html.js";

// The value VS Code returns for `webview.cspSource` for a local extension.
const CSP_SOURCE = "'self' https://*.vscode-cdn.net";
// The value for an extension served over http(s) (remote form).
const REMOTE_CSP_SOURCE = "https://host.example/ext/ 'self' https://*.vscode-cdn.net";
const BASE = "https://webview-resource.example/ext/dist/app";
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Orbitrace</title>
    <script type="module" crossorigin src="./assets/index-0000.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-0000.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("escapeAttribute", () => {
  it("escapes characters that end or break a double-quoted attribute", () => {
    expect(escapeAttribute(`a"b'c<d>e&f`)).toBe("a&quot;b'c&lt;d&gt;e&amp;f");
  });
});

describe("contentSecurityPolicy", () => {
  it("allows only the webview source and no inline script, network or frames", () => {
    const policy = contentSecurityPolicy(CSP_SOURCE);
    const directives = policy.split("; ");
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain(`script-src ${CSP_SOURCE}`);
    expect(directives).toContain(`style-src ${CSP_SOURCE}`);
    expect(directives).toContain("connect-src 'none'");
    expect(directives).toContain("frame-src 'none'");
    expect(directives).toContain("form-action 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("joins every source expression of the remote form into each directive", () => {
    const directives = contentSecurityPolicy(REMOTE_CSP_SOURCE).split("; ");
    expect(directives).toContain(`script-src ${REMOTE_CSP_SOURCE}`);
    expect(directives).toContain(`img-src ${REMOTE_CSP_SOURCE} data:`);
    expect(directives).toContain(`base-uri ${REMOTE_CSP_SOURCE}`);
  });

  it("normalises runs of spaces between expressions", () => {
    expect(contentSecurityPolicy("  'self'   https://*.vscode-cdn.net ")).toContain(
      `script-src ${CSP_SOURCE};`,
    );
  });

  it("refuses a source that would add directives or keywords", () => {
    expect(() => contentSecurityPolicy("")).toThrow();
    expect(() => contentSecurityPolicy("   ")).toThrow();
    expect(() => contentSecurityPolicy("https://a.example; script-src *")).toThrow();
    expect(() => contentSecurityPolicy("https://a.example, https://b.example")).toThrow();
    expect(() => contentSecurityPolicy("'unsafe-inline'")).toThrow();
    expect(() => contentSecurityPolicy("'self' 'unsafe-eval'")).toThrow();
    expect(() => contentSecurityPolicy("'self'\nscript-src *")).toThrow();
    expect(() => contentSecurityPolicy(`'self" https://a.example`)).toThrow();
    expect(() => contentSecurityPolicy("'self' https://a.example/<x>")).toThrow();
    expect(() => contentSecurityPolicy("'self' *")).toThrow();
  });
});

describe("cspSourceTokens", () => {
  it("returns the source expressions of the local and remote forms", () => {
    expect(cspSourceTokens(CSP_SOURCE)).toEqual(["'self'", "https://*.vscode-cdn.net"]);
    expect(cspSourceTokens(REMOTE_CSP_SOURCE)).toEqual([
      "https://host.example/ext/",
      "'self'",
      "https://*.vscode-cdn.net",
    ]);
  });

  it("throws on an expression that is not 'self' or a scheme/host source", () => {
    expect(() => cspSourceTokens("'none'")).toThrow(/unexpected expression/);
    expect(() => cspSourceTokens("a.example")).toThrow(/unexpected expression/);
  });
});

describe("headElements", () => {
  it("adds the host tags in editor mode, with the session when given", () => {
    const elements = headElements({
      cspSource: CSP_SOURCE,
      baseUri: BASE,
      mode: "editor",
      sessionKey: "claude-code:k",
    });
    expect(elements[0]).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    expect(elements[1]).toBe(`<base href="${BASE}/">`);
    expect(elements).toContain(`<meta name="orbitrace-host" content="editor">`);
    expect(elements).toContain(`<meta name="orbitrace-session" content="claude-code:k">`);
  });

  it("adds no host tags in demo mode and no session tag without a key", () => {
    const demo = headElements({
      cspSource: CSP_SOURCE,
      baseUri: `${BASE}/`,
      mode: "demo",
      sessionKey: "x",
    });
    expect(demo.join("")).not.toContain("orbitrace-");
    expect(demo[1]).toBe(`<base href="${BASE}/">`);
    const editor = headElements({ cspSource: CSP_SOURCE, baseUri: BASE, mode: "editor" });
    expect(editor.join("")).not.toContain("orbitrace-session");
  });
});

describe("buildWebviewHtml", () => {
  it("injects the policy, the base and the host tags before the app's scripts", () => {
    const html = buildWebviewHtml(INDEX, {
      cspSource: CSP_SOURCE,
      baseUri: BASE,
      mode: "editor",
      sessionKey: `claude-code:"><script>`,
    });
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head.indexOf("Content-Security-Policy")).toBeLessThan(head.indexOf("<script"));
    expect(head.indexOf("<base ")).toBeLessThan(head.indexOf("<script"));
    expect(html).toContain(
      `<meta name="orbitrace-session" content="claude-code:&quot;&gt;&lt;script&gt;">`,
    );
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`src="./assets/index-0000.js"`);
  });

  it("replaces any policy, base or host tags already in the page", () => {
    const page = INDEX.replace(
      "<title>",
      `<meta http-equiv="content-security-policy" content="default-src *"><base href="https://elsewhere.example/"><meta name="orbitrace-host" content="browser"><title>`,
    );
    const html = buildWebviewHtml(page, { cspSource: CSP_SOURCE, baseUri: BASE, mode: "demo" });
    expect(html).not.toContain("default-src *");
    expect(html).not.toContain("elsewhere.example");
    expect(html).not.toContain(`content="browser"`);
    expect(html.match(/Content-Security-Policy/gi)).toHaveLength(1);
  });

  it("refuses a page with an inline script or without a head", () => {
    const inline = INDEX.replace("</head>", "<script>alert(1)</script></head>");
    expect(() =>
      buildWebviewHtml(inline, { cspSource: CSP_SOURCE, baseUri: BASE, mode: "demo" }),
    ).toThrow(/inline script/);
    expect(() =>
      buildWebviewHtml("<html><body></body></html>", {
        cspSource: CSP_SOURCE,
        baseUri: BASE,
        mode: "demo",
      }),
    ).toThrow(/<head>/);
  });

  it("works on the real app build", () => {
    const built = fileURLToPath(new URL("../../app/dist/index.html", import.meta.url));
    // `npm test` at the root builds the app first.
    expect(existsSync(built)).toBe(true);
    const html = buildWebviewHtml(readFileSync(built, "utf8"), {
      cspSource: CSP_SOURCE,
      baseUri: BASE,
      mode: "editor",
    });
    expect(html).toContain(`<meta name="orbitrace-host" content="editor">`);
    expect(html).toMatch(/<script type="module"[^>]*src="\.\/assets\/[^"]+\.js"/);
  });
});
