/**
 * Contrast of canvas text (#117). The app shell cannot read canvas pixels, so the renderer
 * guarantees the floor by construction: every label is drawn over a backing box in the
 * background colour, and the backing's opacity is chosen from the theme so that the text keeps
 * at least `CONTRAST_FLOOR` against the backing composited over *anything*, from black to white.
 * White is the worst case behind a light label: additive glows (halos, flare tips, comet heads)
 * can stack up to it, and the white effort core and comet heads are white already.
 *
 * Ratios follow WCAG 2.2: relative luminance of sRGB colours, `(L1 + 0.05) / (L2 + 0.05)`.
 * Canvas 2D composites in gamma-encoded sRGB, so a backing at opacity `a` over a colour `u`
 * gives `a * backing + (1 - a) * u` per channel, which is what `mixOver` computes.
 *
 * Runs once per palette (theme.ts), never per frame.
 */

/** WCAG 1.4.3 minimum for text: 4.5 to 1. */
export const CONTRAST_FLOOR = 4.5;
/** What backings aim for, a little above the floor, so faded or rounded values stay above it. */
export const CONTRAST_TARGET = 4.6;

/** An sRGB colour, channels 0 to 255, alpha 0 to 1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export const BLACK: Rgba = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
export const WHITE: Rgba = Object.freeze({ r: 255, g: 255, b: 255, a: 1 });

function rgba(r: number, g: number, b: number, a: number): Rgba {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return Object.freeze({ r: clamp(r, 255), g: clamp(g, 255), b: clamp(b, 255), a: clamp(a, 1) });
}

function channel(part: string): number {
  const text = part.trim();
  if (text.endsWith("%")) return (Number(text.slice(0, -1)) / 100) * 255;
  return Number(text);
}

function alphaPart(part: string | undefined): number {
  if (part === undefined) return 1;
  const text = part.trim();
  if (text.endsWith("%")) return Number(text.slice(0, -1)) / 100;
  return Number(text);
}

/**
 * Parse a CSS colour in hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) or `rgb()` / `rgba()`
 * form (comma or space separated, numbers or percentages). Returns null for anything else,
 * such as a named colour or `hsl()`; callers then fall back to an opaque backing.
 */
export function parseColor(css: string): Rgba | null {
  const text = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex !== null) {
    const digits = hex[1]!;
    const short = digits.length <= 4;
    const at = (k: number): number =>
      short ? parseInt(digits[k]! + digits[k]!, 16) : parseInt(digits.slice(k * 2, k * 2 + 2), 16);
    const count = short ? digits.length : digits.length / 2;
    return rgba(at(0), at(1), at(2), count === 4 ? at(3) / 255 : 1);
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(text);
  if (fn !== null) {
    const body = fn[1]!.trim();
    let parts: string[];
    let alpha: string | undefined;
    if (body.includes(",")) {
      parts = body.split(",");
      alpha = parts.length === 4 ? parts.pop() : undefined;
    } else {
      const [colour, a] = body.split("/");
      parts = colour!.trim().split(/\s+/);
      alpha = a;
    }
    if (parts.length !== 3) return null;
    const values = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alphaPart(alpha)];
    if (values.some((v) => !Number.isFinite(v))) return null;
    return rgba(values[0]!, values[1]!, values[2]!, values[3]!);
  }
  return null;
}

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an opaque sRGB colour (alpha is ignored), 0 to 1. */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio between two relative luminances, 1 to 21. */
export function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` drawn at opacity `alpha` (times its own alpha) over the opaque colour `under`. */
export function mixOver(top: Rgba, alpha: number, under: Rgba): Rgba {
  const a = Math.max(0, Math.min(1, alpha * top.a));
  return rgba(
    a * top.r + (1 - a) * under.r,
    a * top.g + (1 - a) * under.g,
    a * top.b + (1 - a) * under.b,
    1,
  );
}

/**
 * The lowest contrast `text` can have against a `backing` box drawn at opacity `alpha` over
 * any colour at all. The composite's luminance moves monotonically with what is behind, so
 * its extremes are a black and a white background; if the text's own luminance falls between
 * them some background matches it and the answer is 1.
 */
export function worstContrastOverBacking(text: Rgba, backing: Rgba, alpha: number): number {
  const lt = relativeLuminance(text);
  const dark = relativeLuminance(mixOver(backing, alpha, BLACK));
  const light = relativeLuminance(mixOver(backing, alpha, WHITE));
  if (lt >= dark && lt <= light) return 1;
  return Math.min(contrastRatio(lt, dark), contrastRatio(lt, light));
}

/**
 * The lowest backing opacity, at least `minimum` and rounded up to a hundredth, at which
 * `text` keeps `target` contrast over any background (see `worstContrastOverBacking`). Returns
 * 1 when even an opaque backing cannot reach the target (a theme whose text and background
 * colours are too close); an opaque backing is then the best the canvas can do.
 */
export function minBackingAlpha(
  text: Rgba,
  backing: Rgba,
  target = CONTRAST_TARGET,
  minimum = 0,
): number {
  if (worstContrastOverBacking(text, backing, 1) < target) return 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (worstContrastOverBacking(text, backing, mid) >= target) hi = mid;
    else lo = mid;
  }
  return Math.min(1, Math.max(minimum, Math.ceil(hi * 100) / 100));
}

/**
 * Backing opacity per text colour, for a canvas whose background is `background`. Colours
 * that do not parse (named colours, `hsl()`) or are translucent get an opaque backing.
 */
export function backingAlphas(
  background: string,
  colors: readonly string[],
  minimum: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const back = parseColor(background);
  for (const color of colors) {
    if (out.has(color)) continue;
    const text = parseColor(color);
    out.set(
      color,
      back === null || text === null || back.a < 1 || text.a < 1
        ? 1
        : minBackingAlpha(text, back, CONTRAST_TARGET, minimum),
    );
  }
  return out;
}
