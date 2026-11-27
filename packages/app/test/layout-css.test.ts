// @vitest-environment node
// Layout rules behind reflow (WCAG 1.4.10), resize text (1.4.4), text spacing (1.4.12) and focus
// visibility (2.4.7), read from src/app.css. happy-dom lays nothing out, so these guard the rules
// that were measured in a real browser (see ACCESSIBILITY.md) against being undone.

import { describe, expect, it } from "vitest";
import { appCss, declaration, mediaBlock, rule, topLevel } from "./css";

const NARROW = "(max-width: 820px), (max-height: 480px)";
const MEDIUM = "(max-width: 960px)";

describe("no text is cut off with an ellipsis", () => {
  it.each([".session-label", ".lane-name"])("%s wraps", (selector) => {
    const block = rule(selector);
    expect(declaration(block, "white-space")).toBe("normal");
    expect(declaration(block, "overflow-wrap")).toBe("anywhere");
    expect(block).not.toMatch(/text-overflow/);
  });

  it("a session button lets its parts wrap onto a second line", () => {
    expect(declaration(rule(".session-item"), "flex-wrap")).toBe("wrap");
  });

  it("lane labels do not hide what overflows them", () => {
    expect(rule(".lane-label")).not.toMatch(/overflow:\s*hidden/);
  });
});

describe("the open session list stays inside the window", () => {
  it("wide layout: placed against the header and never wider than it", () => {
    expect(declaration(rule(".app-header"), "position")).toBe("relative");
    expect(declaration(rule(".session-picker"), "position")).toBe("static");
    const list = rule(".session-list");
    expect(declaration(list, "position")).toBe("absolute");
    expect(declaration(list, "right")).toBe("var(--space-4)");
    expect(declaration(list, "left")).toBe("auto");
    expect(declaration(list, "max-width")).toBe("calc(100% - 2 * var(--space-4))");
    // A fixed min-width would beat max-width; it must be capped by the header width too.
    expect(declaration(list, "min-width")).toMatch(/^min\(/);
  });

  it("narrow layout: its own row in the page flow, allowed to shrink below its content", () => {
    const narrow = mediaBlock(NARROW);
    const open = rule(".session-picker-open", narrow);
    expect(declaration(open, "flex")).toBe("1 1 100%");
    expect(declaration(open, "min-width")).toBe("0");
    const list = rule(".session-list", narrow);
    expect(declaration(list, "position")).toBe("static");
    expect(declaration(list, "max-width")).toBe("none");
  });
});

describe("timeline label column", () => {
  it("narrows on small screens only as far as the window needs", () => {
    expect(declaration(rule(".timeline"), "--lane-label")).toBe("148px");
    expect(declaration(rule(".timeline", mediaBlock(NARROW)), "--lane-label")).toBe(
      "clamp(112px, 34vw, 148px)",
    );
  });
});

describe("the Playback row never runs under the side panel", () => {
  it("wraps at every width rather than overflowing the dock", () => {
    expect(declaration(rule(".controls"), "flex-wrap")).toBe("wrap");
    expect(declaration(rule(".control-scrub"), "min-width")).toBe("80px");
  });

  it.each([MEDIUM, NARROW])("gives the scrubber its own row at %s", (query) => {
    const scrub = rule(".control-scrub", mediaBlock(query));
    expect(declaration(scrub, "order")).toBe("3");
    expect(declaration(scrub, "flex-basis")).toBe("100%");
  });

  it("the medium breakpoint leaves the dock room for the whole row (issue 127)", () => {
    // Two-column layout: the dock is the window minus the side panel. Measured in Chrome, a live
    // session's row with an hour-long readout needs about 560 px.
    const side = Number(
      /minmax\(0, 1fr\) (\d+)px/.exec(declaration(rule(".app-main"), "grid-template-columns"))?.[1],
    );
    const medium = Number(/max-width: (\d+)px/.exec(MEDIUM)?.[1]);
    expect(side).toBe(360);
    expect(medium - side).toBeGreaterThanOrEqual(560);
  });
});

describe("focus inside scroll areas", () => {
  it("draws the outline inside the inspector and other scroll areas", () => {
    const text = topLevel(appCss);
    const match = /([^{}]*)\{\s*outline-offset:\s*-2px;\s*\}/.exec(text);
    const selectors = (match?.[1] ?? "").split(",").map((s) => s.trim());
    expect(selectors).toEqual(
      expect.arrayContaining([
        ":root .inspector:focus-visible",
        ":root .lane-label:focus-visible",
        ":root .session-item:focus-visible",
      ]),
    );
  });
});

describe("css helpers", () => {
  it("read top-level rules, media blocks and declarations", () => {
    const css =
      ".a { color: red; }\n@media (x) {\n  .a { color: blue; }\n}\n/* c */ .b { top: 0; }";
    expect(declaration(rule(".a", topLevel(css)), "color")).toBe("red");
    expect(declaration(rule(".a", mediaBlock("(x)", css)), "color")).toBe("blue");
    expect(topLevel(css)).not.toContain("blue");
    expect(() => rule(".missing", css)).toThrow(/no rule/);
    expect(() => declaration("color: red;", "top")).toThrow(/no top/);
    expect(() => mediaBlock("(y)", css)).toThrow(/no @media/);
  });
});
