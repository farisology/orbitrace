// The pure parts of the accessibility pass: the scope's text alternative, the live-region
// wording, the scrubber's value text, lane focus movement and the editor's reduced-motion flag.
// Every value is invented.

import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_ANNOUNCE_INTERVAL_MS,
  liveStatusAnnouncement,
  loadedAnnouncement,
  newAgentsAnnouncement,
} from "../src/announce";
import { scrubValueText } from "../src/components/Controls";
import { laneFocusIndex } from "../src/components/Timeline";
import { EDITOR_REDUCED_MOTION_CLASS, prefersReducedMotion } from "../src/reduced-motion";
import { SCOPE_PHASE_LABELS, scopeChangeTimes, scopeRows, scopeSummary } from "../src/scope-text";
import { makeModel } from "./helpers";

const model = makeModel();

describe("scopeChangeTimes", () => {
  it("lists every agent and call start and end once, sorted", () => {
    const times = scopeChangeTimes(model);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    // Agent starts and ends, call starts and ends from the synthetic model.
    for (const t of [0, 4, 4.5, 20, 60, 1, 2, 25, 26, 12]) expect(times).toContain(t);
  });

  it("gives rows that stay the same between two moments", () => {
    const times = scopeChangeTimes(model);
    for (let i = 0; i + 1 < times.length; i += 1) {
      const from = times[i] as number;
      const to = times[i + 1] as number;
      const middle = (from + to) / 2;
      expect(scopeRows(model, middle, null)).toEqual(scopeRows(model, from, null));
    }
  });
});

describe("scopeRows", () => {
  it("describes each agent at the playhead", () => {
    const rows = scopeRows(model, 10.5, "a1");
    expect(rows.map((row) => row.callsign)).toEqual(["main", "widget-explorer", "gadget-builder"]);
    const [main, a1, a2] = rows;
    expect(main).toMatchObject({
      family: "Opus (hexagon)",
      parent: null,
      phase: "running",
      selected: false,
    });
    // Read 1-2 done, two Agent calls running.
    expect(main).toMatchObject({ calls: 3, running: 2, failed: 0 });
    expect(a1).toMatchObject({ parent: "main", selected: true, calls: 2, running: 0 });
    // mcp call 10-11 running.
    expect(a2).toMatchObject({ family: "Sonnet (diamond)", calls: 1, running: 1 });
  });

  it("counts a failed call once its result is in, and phases before, during and after", () => {
    expect(scopeRows(model, 25.5, null)[0]).toMatchObject({ failed: 0, running: 1 });
    expect(scopeRows(model, 26, null)[0]).toMatchObject({ failed: 1, running: 0 });
    expect(scopeRows(model, 3, null)[1]?.phase).toBe("waiting");
    expect(scopeRows(model, 20, null)[1]?.phase).toBe("finished");
    // A call with no end stays running.
    expect(scopeRows(model, 59, null)[2]).toMatchObject({ running: 1, phase: "running" });
  });

  it("is all waiting before the start", () => {
    expect(scopeRows(model, -Infinity, null).every((row) => row.phase === "waiting")).toBe(true);
  });
});

describe("scopeSummary", () => {
  it("counts the phases in words", () => {
    expect(scopeSummary(scopeRows(model, 10, null))).toBe("3 running, 0 finished, 0 not started");
    expect(scopeSummary(scopeRows(model, 2, null))).toBe("1 running, 0 finished, 2 not started");
    expect(SCOPE_PHASE_LABELS.waiting).toBe("Not started");
  });
});

describe("announcements", () => {
  it("says what was loaded", () => {
    expect(loadedAnnouncement("Demo session", model)).toBe(
      "Showing Demo session: 3 agents, 10 tool calls.",
    );
  });

  it("says when a live session changes state, and nothing when it does not", () => {
    expect(liveStatusAnnouncement("busy", "idle")).toBe("Live session is idle.");
    expect(liveStatusAnnouncement("idle", "busy")).toBe("Live session is working.");
    expect(liveStatusAnnouncement("busy", "ended")).toBe("Live session ended.");
    expect(liveStatusAnnouncement("unknown", "ended")).toBeNull();
    expect(liveStatusAnnouncement("busy", "busy")).toBeNull();
    expect(liveStatusAnnouncement("busy", "unknown")).toBeNull();
  });

  it("says how many agents a live snapshot added", () => {
    expect(newAgentsAnnouncement(2, model)).toBe("1 new agent in the live session, 3 in total.");
    expect(newAgentsAnnouncement(1, model)).toBe("2 new agents in the live session, 3 in total.");
    expect(newAgentsAnnouncement(3, model)).toBeNull();
    expect(newAgentsAnnouncement(5, model)).toBeNull();
    expect(LIVE_ANNOUNCE_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe("scrubValueText", () => {
  it("is exact while paused", () => {
    expect(scrubValueText(model, 42, false)).toBe("10:42 of 11:00, real time");
  });

  it("is rounded down to the minute while playing, so it changes rarely", () => {
    expect(scrubValueText(model, 42, true)).toBe("Playing, past 10:00 of 11:00, real time");
    expect(scrubValueText(model, 10, true)).toBe(scrubValueText(model, 20, true));
    expect(scrubValueText(model, 0, true)).toBe("Playing, past 0:00 of 11:00, real time");
  });
});

describe("laneFocusIndex", () => {
  it("moves down and up and stops at the ends", () => {
    expect(laneFocusIndex(0, 3, "ArrowDown")).toBe(1);
    expect(laneFocusIndex(2, 3, "ArrowDown")).toBe(2);
    expect(laneFocusIndex(1, 3, "ArrowUp")).toBe(0);
    expect(laneFocusIndex(0, 3, "ArrowUp")).toBe(0);
  });

  it("ignores other keys and a focus outside the lanes", () => {
    expect(laneFocusIndex(1, 3, "ArrowLeft")).toBeNull();
    expect(laneFocusIndex(1, 3, "Enter")).toBeNull();
    expect(laneFocusIndex(-1, 3, "ArrowDown")).toBeNull();
    expect(laneFocusIndex(0, 0, "ArrowDown")).toBeNull();
  });
});

describe("prefersReducedMotion in an editor tab", () => {
  afterEach(() => {
    document.body.classList.remove(EDITOR_REDUCED_MOTION_CLASS);
  });

  it("follows the class the editor webview puts on the body", () => {
    expect(prefersReducedMotion()).toBe(false);
    document.body.classList.add(EDITOR_REDUCED_MOTION_CLASS);
    expect(prefersReducedMotion()).toBe(true);
  });
});
