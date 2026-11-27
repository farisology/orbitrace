// @vitest-environment node
// Colour contrast from the design tokens the app ships (src/generated/tokens.css) and the
// opacities in src/app.css. axe-core cannot measure contrast in happy-dom (no painted colours),
// so the colour pairs the app uses are checked here with the WCAG 2.1 formula.

import { describe, expect, it } from "vitest";
import { appCss, declaration, rule, tokensCss } from "./css";

type Rgb = readonly [number, number, number];

function token(name: string): Rgb {
  const match = new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, "i").exec(tokensCss);
  if (match === null) throw new Error(`no colour token --${name}`);
  const hex = match[1] as string;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` drawn at `alpha` over `bg`. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => alpha * c + (1 - alpha) * (bg[i] as number)) as unknown as Rgb;
}

const GROUNDS = ["void", "deck", "panel", "rim"] as const;

describe("text contrast (WCAG 1.4.3, 4.5:1)", () => {
  it("every text, brand, dimension and status colour passes on every ground", () => {
    const texts = ["text", "dim", "faint", "ion", "bench", "wire", "pulse", "tape", "ledger"];
    for (const name of [...texts, "rig", "fault", "ok"]) {
      for (const ground of GROUNDS) {
        expect(contrast(token(name), token(ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });
});

describe("non-text contrast (WCAG 1.4.11, 3:1)", () => {
  it("the focus outline is ion and stands out on every ground", () => {
    const focus = rule(":root :focus-visible");
    expect(declaration(focus, "outline")).toBe("2px solid var(--ion)");
    for (const ground of ["void", "deck", "panel"] as const) {
      expect(contrast(token("ion"), token(ground))).toBeGreaterThanOrEqual(3);
    }
  });

  it("no rule removes the focus outline", () => {
    expect(appCss).not.toMatch(/outline:\s*(none|0)\s*;/);
  });

  it("timeline lifetime bars reach 3:1, selected or not", () => {
    const life = rule(".lane-life");
    expect(declaration(life, "fill")).toBe("var(--faint)");
    const alpha = Number(declaration(life, "fill-opacity"));
    for (const ground of ["deck", "panel"] as const) {
      expect(contrast(over(token("faint"), alpha, token(ground)), token(ground))).toBeGreaterThan(
        3,
      );
    }
    const selected = rule(".lane-selected .lane-life");
    expect(declaration(selected, "fill")).toBe("var(--ion)");
    const selectedAlpha = Number(declaration(selected, "fill-opacity"));
    expect(
      contrast(over(token("ion"), selectedAlpha, token("panel")), token("panel")),
    ).toBeGreaterThan(3);
  });

  it("tool call colours on the timeline reach 3:1 on the deck and on a selected lane", () => {
    for (const name of ["pulse", "rig", "bench", "wire", "fault"]) {
      for (const ground of ["deck", "panel"] as const) {
        expect(contrast(token(name), token(ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  });
});

describe("contrast helpers", () => {
  it("match the WCAG reference values", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 2);
    expect(over([255, 255, 255], 0.5, [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
  });
});
