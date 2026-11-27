import { describe, expect, it } from "vitest";
import { formatAgo } from "@orbitrace/core";
import {
  describeSession,
  liveText,
  panelTitle,
  projectText,
  relativeTime,
} from "../src/session-labels.js";
import { makeSummary } from "./helpers.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("relativeTime", () => {
  it("reads minutes, hours and days", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW + 60_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe("1 day ago");
    expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe("4 days ago");
    expect(relativeTime(Number.NaN, NOW)).toBe("just now");
  });

  it("is core's formatter, so this view matches the app's session picker (#129)", () => {
    expect(relativeTime).toBe(formatAgo);
  });
});

describe("liveText", () => {
  it("names running and ended sessions only", () => {
    expect(liveText("busy")).toBe("live");
    expect(liveText("idle")).toBe("live");
    expect(liveText("ended")).toBe("ended");
    expect(liveText("unknown")).toBeNull();
  });
});

describe("projectText", () => {
  it("uses a placeholder for an empty label", () => {
    expect(projectText({ projectLabel: "kite-workshop" })).toBe("kite-workshop");
    expect(projectText({ projectLabel: "  " })).toBe("(unnamed project)");
  });
});

describe("describeSession", () => {
  it("joins time, status and subagents, and never shows the session id", () => {
    const summary = makeSummary({ lastActivity: NOW - 5 * 60_000, live: "busy", subagentCount: 3 });
    const text = describeSession(summary, NOW);
    expect(text.label).toBe("kite-workshop");
    expect(text.description).toBe("5 min ago · live · 3 subagents");
    expect(text.tooltip).toContain("Last activity: 2026-01-15 11:55 UTC");
    expect(text.tooltip).toContain("Subagents: 3");
    expect(JSON.stringify(text)).not.toContain(summary.sessionId);
  });

  it("handles one subagent, none and an uncounted number", () => {
    expect(
      describeSession(makeSummary({ subagentCount: 1, lastActivity: NOW }), NOW).description,
    ).toBe("just now · 1 subagent");
    expect(
      describeSession(makeSummary({ subagentCount: 0, lastActivity: NOW }), NOW).description,
    ).toBe("just now");
    const uncounted = describeSession(makeSummary({ subagentCount: null, lastActivity: NOW }), NOW);
    expect(uncounted.tooltip).toContain("Subagents: not counted");
  });
});

describe("panelTitle", () => {
  it("names the project, or the demo", () => {
    expect(panelTitle({ projectLabel: "kite-workshop" })).toBe("Orbitrace: kite-workshop");
    expect(panelTitle(null)).toBe("Orbitrace: demo");
  });
});
