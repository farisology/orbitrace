// axe-core in the test DOM: the WCAG 2.0 and 2.1 level A and AA rules plus axe's best
// practices, run against what the app rendered. See ACCESSIBILITY.md for what this can and
// cannot catch.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";

/** The rule sets run: WCAG 2.0 and 2.1 at A and AA, and axe's best practices. */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] as const;

/**
 * Rules axe cannot finish in happy-dom, which has no layout and no painted colours. Their
 * "incomplete" result is expected here; contrast is checked from the tokens in contrast.test.ts
 * and in a real browser (ACCESSIBILITY.md).
 */
export const UNDECIDABLE_HERE = new Set(["color-contrast"]);

let styled = false;

/** Put the app's real style sheets into the test document once, as the built page has them. */
export function useAppStyles(): void {
  if (styled) return;
  styled = true;
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const css = [join(srcDir, "generated", "tokens.css"), join(srcDir, "app.css")]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
}

/**
 * Every axe violation, and every "incomplete" result outside `UNDECIDABLE_HERE`, as readable
 * lines. Empty when the page passes.
 */
export async function axeProblems(root: Element = document.body): Promise<string[]> {
  const results = await axe.run(root, {
    runOnly: { type: "tag", values: [...AXE_TAGS] },
    resultTypes: ["violations", "incomplete"],
  });
  const lines: string[] = [];
  for (const result of results.violations) {
    for (const node of result.nodes) {
      lines.push(`violation ${result.id}: ${node.target.join(" ")}: ${node.failureSummary ?? ""}`);
    }
  }
  for (const result of results.incomplete) {
    if (UNDECIDABLE_HERE.has(result.id)) continue;
    for (const node of result.nodes) {
      lines.push(
        `needs review ${result.id}: ${node.target.join(" ")}: ${node.failureSummary ?? ""}`,
      );
    }
  }
  return lines;
}
