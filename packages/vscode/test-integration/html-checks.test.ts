import { describe, expect, it } from "vitest";
import { EDITOR_HOST_META_VALUE, HOST_META_NAME, SESSION_META_NAME } from "@orbitrace/core";
import { buildWebviewHtml } from "../src/webview-html.js";
import {
  baseHrefs,
  contentSecurityPolicies,
  decodeEntities,
  metaContents,
  parseCsp,
  pathInsideBase,
  policyProblems,
  readPage,
  resourceReferences,
  tagAttributes,
} from "./html-checks.js";

// Invented values in the shape VS Code uses.
const CSP_SOURCE = "'self' https://*.vscode-cdn.net";
const BASE = "https://file%2B.vscode-resource.vscode-cdn.net/workspace/ext/dist/app/";
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="favicon.svg" />
    <title>Orbitrace</title>
    <script type="module" crossorigin src="./assets/index-0000.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-0000.css">
  </head>
  <body><div id="root"><img src="mark.svg" alt=""><a href="https://example.com/">x</a></div></body>
</html>`;

function editorPage(sessionKey = "claude-code:test-1"): string {
  return buildWebviewHtml(INDEX, {
    cspSource: CSP_SOURCE,
    baseUri: BASE,
    mode: "editor",
    sessionKey,
  });
}

describe("tagAttributes", () => {
  it("reads double-quoted, single-quoted, bare and empty attributes, names in lower case", () => {
    const html = `<script TYPE="module" crossorigin src='./a.js' data-x=1></script>`;
    expect(tagAttributes(html, "script")).toEqual([
      { type: "module", crossorigin: "", src: "./a.js", "data-x": "1" },
    ]);
  });

  it("returns one record per tag, in document order, and decodes entities", () => {
    const html = `<meta name="a" content="x &amp; y"><meta name="b" content="&quot;q&quot;">`;
    expect(tagAttributes(html, "meta")).toEqual([
      { name: "a", content: "x & y" },
      { name: "b", content: '"q"' },
    ]);
  });

  it("does not match a longer tag name", () => {
    expect(tagAttributes(`<metadata name="a">`, "meta")).toEqual([]);
  });
});

describe("decodeEntities", () => {
  it("decodes the entities attribute writers use, ampersand last", () => {
    expect(decodeEntities("&quot;&#39;&lt;&gt;&amp;lt;")).toBe(`"'<>&lt;`);
  });
});

describe("metaContents and contentSecurityPolicies", () => {
  it("read the host meta tags and the policy of an editor page", () => {
    const html = editorPage();
    expect(metaContents(html, HOST_META_NAME)).toEqual([EDITOR_HOST_META_VALUE]);
    expect(metaContents(html, SESSION_META_NAME.toUpperCase())).toEqual(["claude-code:test-1"]);
    expect(contentSecurityPolicies(html)).toHaveLength(1);
    expect(contentSecurityPolicies(html)[0]).toContain("default-src 'none'");
  });

  it("find no host tags on a demo page", () => {
    const html = buildWebviewHtml(INDEX, { cspSource: CSP_SOURCE, baseUri: BASE, mode: "demo" });
    expect(metaContents(html, HOST_META_NAME)).toEqual([]);
    expect(metaContents(html, SESSION_META_NAME)).toEqual([]);
  });
});

describe("parseCsp", () => {
  it("splits directives, lower-cases names and keeps the first of a repeated directive", () => {
    const parsed = parseCsp("Default-Src 'none'; script-src 'self' a: ; script-src *;;");
    expect(parsed.get("default-src")).toEqual(["'none'"]);
    expect(parsed.get("script-src")).toEqual(["'self'", "a:"]);
    expect(parsed.size).toBe(2);
  });
});

describe("baseHrefs and resourceReferences", () => {
  it("read the base and every loaded resource, without anchors", () => {
    const html = editorPage();
    expect(baseHrefs(html)).toEqual([BASE]);
    expect(resourceReferences(html)).toEqual([
      "./assets/index-0000.js",
      "mark.svg",
      "favicon.svg",
      "./assets/index-0000.css",
    ]);
  });
});

describe("pathInsideBase", () => {
  it("maps relative references to a path below the base", () => {
    expect(pathInsideBase("./assets/a.js", BASE)).toBe("assets/a.js");
    expect(pathInsideBase("mark.svg", BASE.replace(/\/$/, ""))).toBe("mark.svg");
    expect(pathInsideBase("assets/a%20b.css", BASE)).toBe("assets/a b.css");
  });

  it("refuses references outside the base folder or on another origin", () => {
    expect(pathInsideBase("../extension.js", BASE)).toBeNull();
    expect(pathInsideBase("/elsewhere/a.js", BASE)).toBeNull();
    expect(pathInsideBase("https://example.com/a.js", BASE)).toBeNull();
    expect(pathInsideBase("//example.com/a.js", BASE)).toBeNull();
  });

  it("refuses the base itself, queries, fragments and unparsable input", () => {
    expect(pathInsideBase("./", BASE)).toBeNull();
    expect(pathInsideBase("a.js?v=1", BASE)).toBeNull();
    expect(pathInsideBase("a.js#x", BASE)).toBeNull();
    expect(pathInsideBase("a.js", "not a url")).toBeNull();
    expect(pathInsideBase("bad%zz.js", BASE)).toBeNull();
  });
});

describe("readPage", () => {
  it("collects every fact of one page", () => {
    const facts = readPage(editorPage("claude-code:test-2"));
    expect(facts.policies).toHaveLength(1);
    expect(facts.hostMeta).toEqual([EDITOR_HOST_META_VALUE]);
    expect(facts.sessionMeta).toEqual(["claude-code:test-2"]);
    expect(facts.bases).toEqual([BASE]);
    expect(facts.resources).toContain("./assets/index-0000.js");
  });

  it("reads the meta tags by core's names, not by other orbitrace-* tags", () => {
    const html = `<meta name="${HOST_META_NAME}" content="${EDITOR_HOST_META_VALUE}"><meta name="orbitrace-other" content="x"><meta name="${SESSION_META_NAME}" content="claude-code:test-3">`;
    const facts = readPage(html);
    expect(facts.hostMeta).toEqual([EDITOR_HOST_META_VALUE]);
    expect(facts.sessionMeta).toEqual(["claude-code:test-3"]);
  });
});

describe("policyProblems", () => {
  it("finds no problem in the policy the extension writes", () => {
    const [policy] = contentSecurityPolicies(editorPage());
    expect(policyProblems(policy ?? "", CSP_SOURCE)).toEqual([]);
  });

  it("reports missing directives, other sources and unsafe keywords", () => {
    const problems = policyProblems(
      "default-src *; script-src 'self' https://*.vscode-cdn.net 'unsafe-inline'; connect-src https:",
      CSP_SOURCE,
    );
    expect(problems).toContain(`default-src is "*", expected "'none'"`);
    expect(problems).toContain("frame-src is missing");
    expect(problems).toContain("style-src is missing");
    expect(problems).toContain("img-src is missing");
    expect(problems).toContain("script-src allows 'unsafe-inline'");
    expect(problems).toContain("connect-src allows https:");
    expect(problems).toContain("default-src allows *");
  });

  it("requires exactly the webview sources, not a subset", () => {
    const [policy] = contentSecurityPolicies(editorPage());
    const problems = policyProblems(policy ?? "", `${CSP_SOURCE} https://other.example`);
    expect(problems.some((problem) => problem.startsWith("script-src is"))).toBe(true);
  });
});
