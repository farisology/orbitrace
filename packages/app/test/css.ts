// Reads the shipped style sheets for tests that check colours and layout rules from the source,
// because happy-dom paints nothing and lays nothing out.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

export const tokensCss = readFileSync(join(srcDir, "generated", "tokens.css"), "utf8");
export const appCss = readFileSync(join(srcDir, "app.css"), "utf8");

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The declarations of the first rule whose selector is exactly `selector` in `css` (default: the
 * app style sheet, top level only). Pass a block from `mediaBlock` to read a rule inside it.
 */
export function rule(selector: string, css: string = appCss): string {
  const match = new RegExp(`(?:^|\\n)[ \\t]*${escape(selector)}\\s*\\{([^}]*)\\}`).exec(
    css === appCss ? topLevel(css) : css,
  );
  if (match === null) throw new Error(`no rule ${selector}`);
  return match[1] as string;
}

/** The value of `property` in a rule's declarations. */
export function declaration(block: string, property: string): string {
  const match = new RegExp(`(?:^|[;\\s])${escape(property)}:\\s*([^;]+);`).exec(block);
  if (match === null) throw new Error(`no ${property}`);
  return (match[1] as string).trim();
}

/** The body of the `@media` block whose query is exactly `query`. */
export function mediaBlock(query: string, css: string = appCss): string {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) throw new Error(`no @media ${query}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`unclosed @media ${query}`);
}

/** `css` with every `@media` block and comment removed, leaving the top-level rules. */
export function topLevel(css: string): string {
  let out = "";
  let depth = 0;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let i = 0; i < text.length; i += 1) {
    if (depth === 0 && text.startsWith("@media", i)) {
      const open = text.indexOf("{", i);
      let inner = 0;
      let j = open;
      for (; j < text.length; j += 1) {
        if (text[j] === "{") inner += 1;
        if (text[j] === "}") {
          inner -= 1;
          if (inner === 0) break;
        }
      }
      i = j;
      continue;
    }
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    out += text[i];
  }
  return out;
}
