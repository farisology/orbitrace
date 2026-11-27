/**
 * Reads the page an editor tab was given (`panel.webview.html`) for the integration suite:
 * its Content-Security-Policy, its meta tags, its `<base>` and the resources it loads, and maps
 * each resource back to a file of the app folder.
 *
 * The page is built by `src/webview-html.ts` from the app's Vite output, whose tags are simple
 * and double-quoted, so attribute matching with regular expressions is enough here. No vscode
 * dependency, so it is unit tested (`html-checks.test.ts`). The meta tag names come from core's
 * protocol module, the one copy the extension and the app use.
 */

import { HOST_META_NAME, SESSION_META_NAME } from "@orbitrace/core";

/** The attributes of every tag named `tag` (lower-cased names), in document order. */
export function tagAttributes(html: string, tag: string): Record<string, string>[] {
  const tags = html.match(new RegExp(`<${tag}\\b[^>]*>`, "gi")) ?? [];
  return tags.map((text) => {
    const attributes: Record<string, string> = {};
    const pattern =
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    // Skip the tag name itself.
    const body = text.replace(new RegExp(`^<${tag}`, "i"), "").replace(/\/?>$/, "");
    for (const match of body.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      attributes[name.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
    return attributes;
  });
}

/** The five entities `escapeAttribute` and HTML writers use, decoded. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The `content` of every `<meta name="<name>">`, in document order. */
export function metaContents(html: string, name: string): string[] {
  return tagAttributes(html, "meta")
    .filter((attributes) => attributes.name?.toLowerCase() === name.toLowerCase())
    .map((attributes) => attributes.content ?? "");
}

/** The `content` of every `<meta http-equiv="Content-Security-Policy">`. */
export function contentSecurityPolicies(html: string): string[] {
  return tagAttributes(html, "meta")
    .filter((attributes) => attributes["http-equiv"]?.toLowerCase() === "content-security-policy")
    .map((attributes) => attributes.content ?? "");
}

/** A policy split into directives: name (lower case) to its source expressions. */
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const tokens = part
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "");
    const name = tokens.shift()?.toLowerCase();
    // The first occurrence of a directive wins, as in a browser.
    if (name !== undefined && !directives.has(name)) directives.set(name, tokens);
  }
  return directives;
}

/** The `href` of every `<base>`. */
export function baseHrefs(html: string): string[] {
  return tagAttributes(html, "base").map((attributes) => attributes.href ?? "");
}

/**
 * Every URL the page loads by itself: `src` of scripts and images, `href` of stylesheets and
 * icons. Anchors are not loads and are left out.
 */
export function resourceReferences(html: string): string[] {
  const refs: string[] = [];
  for (const attributes of tagAttributes(html, "script")) {
    if (attributes.src !== undefined) refs.push(attributes.src);
  }
  for (const attributes of tagAttributes(html, "img")) {
    if (attributes.src !== undefined) refs.push(attributes.src);
  }
  for (const attributes of tagAttributes(html, "link")) {
    if (attributes.href !== undefined) refs.push(attributes.href);
  }
  return refs;
}

/**
 * The path of `reference`, resolved against `base`, relative to `base`, with forward slashes
 * and percent-decoded segments. Null when it resolves outside `base` (another origin, or a
 * path that does not start with the base path), or when it carries a query or fragment.
 */
export function pathInsideBase(reference: string, base: string): string | null {
  let baseUrl: URL;
  let resolved: URL;
  try {
    baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
    resolved = new URL(reference, baseUrl);
  } catch {
    return null;
  }
  if (resolved.origin !== baseUrl.origin || resolved.protocol !== baseUrl.protocol) return null;
  if (resolved.search !== "" || resolved.hash !== "") return null;
  if (!resolved.pathname.startsWith(baseUrl.pathname)) return null;
  const rest = resolved.pathname.slice(baseUrl.pathname.length);
  if (rest === "") return null;
  try {
    return rest.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

/** What the suite asserts about one page. */
export interface PageFacts {
  readonly policies: readonly string[];
  readonly hostMeta: readonly string[];
  readonly sessionMeta: readonly string[];
  readonly bases: readonly string[];
  readonly resources: readonly string[];
}

/** Every fact `PageFacts` holds, read from one page. */
export function readPage(html: string): PageFacts {
  return {
    policies: contentSecurityPolicies(html),
    hostMeta: metaContents(html, HOST_META_NAME),
    sessionMeta: metaContents(html, SESSION_META_NAME),
    bases: baseHrefs(html),
    resources: resourceReferences(html),
  };
}

/**
 * Problems with a page's policy, as sentences; empty when it is as strict as
 * `src/webview-html.ts` promises: nothing by default, no network, no frames, workers, plugins
 * or forms, and scripts, styles and fonts only from exactly the webview's own sources, never
 * inline.
 */
export function policyProblems(policy: string, cspSource: string): string[] {
  const directives = parseCsp(policy);
  const sources = cspSource.split(/\s+/).filter((token) => token !== "");
  const problems: string[] = [];
  const expectExactly = (name: string, wanted: readonly string[]): void => {
    const actual = directives.get(name);
    if (actual === undefined) {
      problems.push(`${name} is missing`);
      return;
    }
    const same = actual.length === wanted.length && wanted.every((token) => actual.includes(token));
    if (!same) problems.push(`${name} is "${actual.join(" ")}", expected "${wanted.join(" ")}"`);
  };
  for (const name of [
    "default-src",
    "connect-src",
    "frame-src",
    "worker-src",
    "object-src",
    "form-action",
  ]) {
    expectExactly(name, ["'none'"]);
  }
  for (const name of ["script-src", "style-src", "font-src", "base-uri"]) {
    expectExactly(name, sources);
  }
  expectExactly("img-src", [...sources, "data:"]);
  for (const [name, tokens] of directives) {
    for (const token of tokens) {
      if (/^'unsafe-|^'nonce-|^'sha\d+-|^\*$|^https?:$/i.test(token)) {
        problems.push(`${name} allows ${token}`);
      }
    }
  }
  return problems;
}
