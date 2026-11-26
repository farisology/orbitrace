import { TOOL_KINDS } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens, realSeconds } from "../src/format.js";
import { DESIGN_COLORS, FAMILY_SHAPES } from "../src/generated/design.js";
import { FONTS, IntLabelCache, Label, measureLabel } from "../src/labels.js";
import { effortFill, innerScale, shapeForFamily, traceShape } from "../src/shapes.js";
import {
  BUCKET_AGENT,
  BUCKET_EDIT,
  BUCKET_FAILURE,
  BUCKET_READ,
  BUCKET_SHELL,
  DEFAULT_THEME,
  bucketFor,
  createPalette,
  resolveTheme,
} from "../src/theme.js";
import { MockContext } from "./support/mock-context.js";

describe("theme", () => {
  it("maps tool kinds to the design token colours", () => {
    expect(DEFAULT_THEME).toEqual({
      background: DESIGN_COLORS.void,
      text: DESIGN_COLORS.text,
      shell: DESIGN_COLORS.pulse,
      read: DESIGN_COLORS.rig,
      edit: DESIGN_COLORS.bench,
      agent: DESIGN_COLORS.wire,
      handback: DESIGN_COLORS.bench,
      failure: DESIGN_COLORS.fault,
    });
  });

  it("resolves overrides and ignores empty values", () => {
    const theme = resolveTheme({ shell: "rgb(1, 2, 3)", read: "  " });
    expect(theme.shell).toBe("rgb(1, 2, 3)");
    expect(theme.read).toBe(DEFAULT_THEME.read);
    expect(resolveTheme()).toEqual(DEFAULT_THEME);
  });

  it("colours a call by kind, failures first, unknown kinds as read", () => {
    expect(bucketFor("shell", false)).toBe(BUCKET_SHELL);
    expect(bucketFor("read", false)).toBe(BUCKET_READ);
    expect(bucketFor("mcp", false)).toBe(BUCKET_READ);
    expect(bucketFor("other", false)).toBe(BUCKET_READ);
    expect(bucketFor("edit", false)).toBe(BUCKET_EDIT);
    expect(bucketFor("agent", false)).toBe(BUCKET_AGENT);
    expect(bucketFor("future-kind", false)).toBe(BUCKET_READ);
    for (const kind of TOOL_KINDS) expect(bucketFor(kind, true)).toBe(BUCKET_FAILURE);
  });

  it("builds a palette whose buckets follow the theme", () => {
    const palette = createPalette(resolveTheme({ edit: "#123456" }));
    expect(palette.buckets[BUCKET_EDIT]).toBe("#123456");
    expect(palette.buckets[BUCKET_FAILURE]).toBe(DEFAULT_THEME.failure);
    expect(palette.main).toBe(DESIGN_COLORS.ion);
    expect(palette.tokenArc).toBe(DESIGN_COLORS.ledger);
  });
});

describe("shapes", () => {
  it("draws families outside KNOWN_MODEL_FAMILIES as unknown", () => {
    expect(shapeForFamily("opus").family).toBe("opus");
    expect(shapeForFamily("gizmo").family).toBe("unknown");
    expect(shapeForFamily("unknown").points).toBeNull();
  });

  it("returns effort fills from the design file, 0.25 when not recorded", () => {
    expect(effortFill("low")).toBe(0);
    expect(effortFill("medium")).toBe(0.4);
    expect(effortFill("max")).toBe(1);
    expect(effortFill(null)).toBe(0.25);
    expect(innerScale(1)).toBeCloseTo(0.85);
    expect(innerScale(0.4)).toBeCloseTo(0.49);
  });

  it("traces a polygon scaled by the radius, or a circle", () => {
    const ctx = new MockContext();
    traceShape(ctx.asDrawContext(), shapeForFamily("opus"), 100, 50, 10);
    expect(ctx.ops[0]!.op).toBe("beginPath");
    expect(ctx.ops[1]).toEqual({ op: "moveTo", args: [100, 50 - 11] });
    expect(ctx.count("lineTo")).toBe(FAMILY_SHAPES.opus.points.length - 1);
    expect(ctx.ops.at(-1)!.op).toBe("closePath");

    ctx.clear();
    traceShape(ctx.asDrawContext(), shapeForFamily("gizmo"), 5, 6, 7);
    expect(ctx.ops).toEqual([
      { op: "beginPath", args: [] },
      { op: "arc", args: [5, 6, 7, 0, Math.PI * 2] },
    ]);
  });

  it("keeps the haiku core point below the centre", () => {
    expect(shapeForFamily("haiku").coreY).toBeCloseTo(0.18);
  });
});

describe("format", () => {
  it("formats token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(4_100_000)).toBe("4.1M");
    expect(formatTokens(1_250_000_000)).toBe("1.25B");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(185)).toBe("3m05s");
    expect(formatDuration(4020)).toBe("1h07m");
    expect(formatDuration(-3)).toBe("0s");
  });

  it("maps compressed time to real time through the warps", () => {
    const warps = [
      { at: 10, skipped: 100 },
      { at: 20, skipped: 50 },
    ];
    expect(realSeconds(warps, 5)).toBe(5);
    expect(realSeconds(warps, 10)).toBe(10);
    expect(realSeconds(warps, 15)).toBe(115);
    expect(realSeconds(warps, 25)).toBe(175);
  });
});

describe("labels", () => {
  it("measures a label once and reuses the width", () => {
    const ctx = new MockContext();
    const label = new Label("main", FONTS.main);
    expect(measureLabel(ctx.asDrawContext(), label)).toBe(24);
    expect(measureLabel(ctx.asDrawContext(), label)).toBe(24);
    expect(ctx.measureCount).toBe(1);
    expect(ctx.font).toBe(FONTS.main.css);
  });

  it("interns integer labels and caps the value", () => {
    const cache = new IntLabelCache(FONTS.small, (n) => `${n}s`, 100);
    const a = cache.get(12.4);
    expect(a.text).toBe("12s");
    expect(cache.get(12)).toBe(a);
    expect(cache.get(-4).text).toBe("0s");
    expect(cache.get(5000).text).toBe("100s");
    expect(cache.size).toBe(3);
  });
});
