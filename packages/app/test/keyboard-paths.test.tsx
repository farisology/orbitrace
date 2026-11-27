// Keyboard paths through the app with Testing Library user events: the skip link, the tab
// order, the session picker, the timeline lanes, the inspector and the event feed. Also the
// text alternative of the orrery and the live region. Every value is invented.

import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplayModel, ReplaySubagent, SessionSummary } from "@orbitrace/core";
import { App, APP_MESSAGES } from "../src/App";
import { createClock } from "../src/clock";
import { INSPECTOR_HEADING_ID } from "../src/components/Inspector";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { ScopeTable } from "../src/components/ScopeTable";
import { createDemoTransport } from "../src/demo-session";
import {
  EDITOR_REDUCED_MOTION_CLASS,
  REDUCED_MOTION_QUERY,
  usePrefersReducedMotion,
} from "../src/reduced-motion";
import type { HostTransport } from "../src/transport";
import { ClockContext } from "../src/use-clock";
import { NO_START_OPTIONS, type StartOptions } from "../src/url-state";
import {
  SUMMARY,
  fakeOrrery,
  makeModel,
  manualFrames,
  rendererCreated,
  replayUpdate,
  scriptedHost,
  stillFrames,
  type FakeOrrery,
} from "./helpers";

const SESSIONS: SessionSummary[] = [
  SUMMARY,
  { ...SUMMARY, key: "session-2", projectLabel: "example-gadgets", live: "ended" },
];

function renderApp(
  transport: HostTransport,
  options: {
    start?: Partial<StartOptions>;
    sessions?: readonly SessionSummary[];
    onSessionChange?: (key: string) => void;
    orrery?: FakeOrrery;
  } = {},
) {
  const orrery = options.orrery ?? fakeOrrery();
  const result = render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <App
        transport={transport}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, paused: true, ...options.start }}
        {...(options.sessions !== undefined
          ? {
              sessions: options.sessions,
              sessionKey: options.sessions[0]?.key ?? "",
              onSessionChange: options.onSessionChange ?? (() => {}),
            }
          : {})}
      />
    </OrreryFactoryContext.Provider>,
  );
  return { ...result, orrery };
}

async function showLiveModel(host: ReturnType<typeof scriptedHost>) {
  await waitFor(() => expect(host.subscribed).toHaveLength(1));
  act(() => host.push(replayUpdate(makeModel(), "busy")));
}

const scrubber = () => screen.getByRole("slider", { name: "Replay position" }) as HTMLInputElement;
const lanes = () => screen.getByRole("list", { name: "Agents" });
const laneButton = (callsign: string) =>
  within(lanes()).getByRole("button", { name: new RegExp(`^${callsign}`) });
const liveRegion = () => document.querySelector('[aria-live="polite"][aria-atomic="true"]');

/**
 * Name of the focused element for tab order checks: its aria-label or aria-labelledby text, or
 * its text without the parts hidden from screen readers.
 */
function focusedName(): string {
  const active = document.activeElement as HTMLElement | null;
  if (active === null || active === document.body) return "(page)";
  const label = active.getAttribute("aria-label");
  if (label !== null) return label;
  const labelledBy = active.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    return labelledBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  if (active.tagName === "SELECT") return "Speed";
  const copy = active.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (copy.textContent ?? "").trim();
}

afterEach(() => {
  document.body.classList.remove(EDITOR_REDUCED_MOTION_CLASS);
  vi.restoreAllMocks();
});

describe("tab order", () => {
  it("starts with the skip link, then the header, the controls, the timeline and the panels", async () => {
    const user = userEvent.setup();
    const host = scriptedHost(SESSIONS);
    renderApp(host, { sessions: SESSIONS });
    await showLiveModel(host);

    const stops: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      await user.tab();
      stops.push(focusedName());
    }
    expect(stops).toEqual([
      APP_MESSAGES.skipToControls,
      "Sessions (2)",
      "Open file",
      "Play",
      // The session is running and the view does not follow it (paused start), so Go live is next.
      "Go live",
      "Speed",
      "Replay position",
      "skip 10 min: idle skip at 0:30. Jump here.",
      "main, 1 failed",
      "widget-explorer, 1 failed",
      "gadget-builder",
      // The inspector region is a Tab stop of its own, so it can be scrolled by keyboard even
      // with nothing inside to focus. The feed has no events at 0:00, so focus then leaves the
      // page and comes back to the skip link.
      "Session",
      "(page)",
      APP_MESSAGES.skipToControls,
    ]);
  });

  it("the skip link moves focus to the play button", async () => {
    const user = userEvent.setup();
    renderApp(createDemoTransport());
    await screen.findByRole("list", { name: "Agents" });
    await user.tab();
    expect(document.activeElement?.textContent).toBe(APP_MESSAGES.skipToControls);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play" }));
    // Space on the focused play button presses it once.
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "Pause" })).toBe(document.activeElement);
  });
});

describe("page shortcuts", () => {
  it("Space plays and pauses, arrows scrub, Home and End jump, with focus on the page", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host, { start: { time: 10 } });
    await showLiveModel(host);
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
    await user.keyboard(" ");
    await user.keyboard("{ArrowRight}");
    expect(Number(scrubber().value)).toBe(15);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(Number(scrubber().value)).toBe(0);
    await user.keyboard("{End}");
    expect(Number(scrubber().value)).toBe(60);
    await user.keyboard("{Home}");
    expect(Number(scrubber().value)).toBe(0);
  });

  it("a letter key does nothing (no single-character shortcuts)", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host);
    await showLiveModel(host);
    await user.keyboard("k");
    expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
  });
});

describe("follow live", () => {
  const goLive = () => screen.getByRole("button", { name: "Go live" });
  const badgeText = () => screen.getByText(/^Live: /).textContent;

  it("Go live is a Tab stop after Play, pressed with Enter or Space; focus stays on it", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host, { start: { time: 10 } });
    await showLiveModel(host);
    expect(badgeText()).toMatch(/behind$/);
    screen.getByRole("button", { name: "Play" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(goLive());
    expect(goLive().getAttribute("aria-keyshortcuts")).toBe("End");
    await user.keyboard("{Enter}");
    expect(badgeText()).toBe("Live: working, following");
    expect(Number(scrubber().value)).toBe(60);
    // Following: still focused, marked unavailable, and pressing it again changes nothing.
    expect(document.activeElement).toBe(goLive());
    expect(goLive().getAttribute("aria-disabled")).toBe("true");
    await user.keyboard(" ");
    expect(badgeText()).toBe("Live: working, following");
    // Space on the page (not on a button) pauses, which leaves follow; Space on Go live does not.
    goLive().blur();
    await user.keyboard(" ");
    expect(badgeText()).toBe("Live: working, not following");
    goLive().focus();
    await user.keyboard(" ");
    expect(badgeText()).toBe("Live: working, following");
  });

  it("End goes live from anywhere on the page; Left leaves follow", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host, { start: { time: 10 } });
    await showLiveModel(host);
    laneButton("main").focus();
    await user.keyboard("{End}");
    expect(badgeText()).toBe("Live: working, following");
    expect(document.activeElement).toBe(laneButton("main"));
    await user.keyboard("{ArrowLeft}");
    expect(badgeText()).toMatch(/^Live: working, [45] s behind$/);
  });

  it("says entering and leaving follow in the live region", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host, { start: { time: 10 } });
    await showLiveModel(host);
    await user.keyboard("{End}");
    expect(liveRegion()?.textContent).toBe("Following the live session.");
    await user.keyboard("{Home}");
    expect(liveRegion()?.textContent).toBe(
      "Stopped following the live session. Go live, or press End, to return.",
    );
  });
});

describe("timeline lanes", () => {
  it("Enter selects, Up and Down move between lanes, arrows scrub, Escape clears", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host, { start: { time: 10 } });
    await showLiveModel(host);

    laneButton("main").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(laneButton("widget-explorer"));
    await user.keyboard("{Enter}");
    expect(laneButton("widget-explorer").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "widget-explorer" })).toBeDefined();

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(laneButton("gadget-builder"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(laneButton("widget-explorer"));

    // Left and Right scrub from a focused lane label too.
    await user.keyboard("{ArrowRight}");
    expect(Number(scrubber().value)).toBe(15);

    await user.keyboard("{Escape}");
    expect(laneButton("widget-explorer").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(laneButton("widget-explorer"));
  });

  it("an idle skip marker jumps there with Enter", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host);
    await showLiveModel(host);
    screen.getByRole("button", { name: /^skip 10 min/ }).focus();
    await user.keyboard("{Enter}");
    expect(Number(scrubber().value)).toBe(30);
  });
});

describe("inspector", () => {
  it("is a named Tab stop with nothing selected, so a keyboard user can scroll it", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host);
    await showLiveModel(host);
    const inspector = screen.getByRole("region", { name: "Session" });
    expect(inspector.tabIndex).toBe(0);
    laneButton("gadget-builder").focus();
    await user.tab();
    expect(document.activeElement).toBe(inspector);
    // Up and Down are not page shortcuts, so they are left to the region to scroll.
    const before = Number(scrubber().value);
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(Number(scrubber().value)).toBe(before);
    expect(document.activeElement).toBe(inspector);
  });

  it("Clear selection by keyboard puts focus on the inspector heading", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host, { start: { select: "a1" } });
    await showLiveModel(host);
    const clear = screen.getByRole("button", { name: "Clear selection" });
    clear.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
    expect(document.activeElement?.id).toBe(INSPECTOR_HEADING_ID);
  });

  it("Escape on Clear selection also keeps focus in the inspector", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host, { start: { select: "a1" } });
    await showLiveModel(host);
    screen.getByRole("button", { name: "Clear selection" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "Session" })).toBe(document.activeElement);
  });
});

describe("session picker", () => {
  it("opens with Enter, closes with Escape without clearing the selection, focus on its summary", async () => {
    const user = userEvent.setup();
    const host = scriptedHost(SESSIONS);
    renderApp(host, { sessions: SESSIONS, start: { select: "a1" } });
    await showLiveModel(host);
    const toggle = screen.getByRole("button", { name: "Sessions (2)" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.tab();
    expect(document.activeElement?.textContent).toContain("example-project");
    await user.keyboard("{Escape}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(laneButton("widget-explorer").getAttribute("aria-pressed")).toBe("true");
  });

  it("choosing a session with Enter closes the list and returns focus to its summary", async () => {
    const user = userEvent.setup();
    const host = scriptedHost(SESSIONS);
    const onSessionChange = vi.fn();
    renderApp(host, { sessions: SESSIONS, onSessionChange });
    await showLiveModel(host);
    const toggle = screen.getByRole("button", { name: "Sessions (2)" });
    toggle.focus();
    await user.keyboard(" ");
    await user.tab();
    await user.tab();
    expect(document.activeElement?.textContent).toContain("example-gadgets");
    await user.keyboard("{Enter}");
    expect(onSessionChange).toHaveBeenCalledWith("session-2");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
});

describe("event feed and errors", () => {
  it("an event is reached by Tab and jumps there with Enter", async () => {
    const user = userEvent.setup();
    const host = scriptedHost();
    renderApp(host);
    await showLiveModel(host);
    await user.keyboard("{End}");
    const feed = screen.getByRole("region", { name: "Events" });
    const failures = within(feed).getByRole("button", { name: /2 failed calls/ });
    failures.focus();
    await user.keyboard("{Enter}");
    expect(Number(scrubber().value)).toBe(25);
  });

  it("dismissing a file error puts focus back on Open file", async () => {
    const user = userEvent.setup();
    const { container } = renderApp(createDemoTransport());
    await screen.findByRole("list", { name: "Agents" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(
      input,
      new File([JSON.stringify({ formatVersion: 1, agents: [] })], "broken.replay.json"),
    );
    const alert = await screen.findByRole("alert");
    within(alert).getByRole("button", { name: "Dismiss" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open file" }));
  });
});

describe("text alternative of the orrery", () => {
  it("is a table of agents with their state at the playhead", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { time: 10.5, select: "a1" } });
    await showLiveModel(host);
    const table = screen.getByRole("table", { name: /Agents in the orrery at the playhead/ });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[2]?.textContent).toContain("widget-explorer, selected");
    expect(rows[2]?.textContent).toContain("Haiku (triangle)");
    expect(rows[2]?.textContent).toContain("Running");
    // Not a live region: it never announces on its own.
    expect(table.closest("[aria-live]")).toBeNull();
  });

  it("re-renders only when the playhead crosses a moment where a row changes", () => {
    const model = makeModel();
    const clock = createClock();
    clock.reset({ duration: model.totals.duration, time: 6.1 });
    render(
      <ClockContext.Provider value={clock}>
        <ScopeTable model={model} selected={null} id="scope" />
      </ClockContext.Provider>,
    );
    const table = document.getElementById("scope") as HTMLTableElement;
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(table, { subtree: true, childList: true, characterData: true });
    // 6.1 to 6.9: no call or agent starts or ends (the next moment is 7).
    for (const t of [6.2, 6.4, 6.6, 6.8, 6.9]) act(() => clock.seek(t));
    expect(observer.takeRecords().length + changes.length).toBe(0);
    act(() => clock.seek(7));
    expect(observer.takeRecords().length + changes.length).toBeGreaterThan(0);
    observer.disconnect();
  });
});

describe("live region", () => {
  it("says what loaded, when a live session changes state and when it gains agents", async () => {
    const host = scriptedHost();
    renderApp(host);
    await showLiveModel(host);
    expect(liveRegion()?.textContent).toBe("Showing example-project: 3 agents, 10 tool calls.");

    act(() => host.push(replayUpdate(makeModel(), "idle")));
    expect(liveRegion()?.textContent).toBe("Live session is idle.");

    const bigger = makeModel();
    const extra = { ...bigger.agents[2]!, id: "a3" as const, callsign: "gizmo-checker" };
    act(() => host.push(replayUpdate({ ...bigger, agents: [...bigger.agents, extra] }, "busy")));
    expect(liveRegion()?.textContent).toBe(
      "Live session is working. 1 new agent in the live session, 4 in total.",
    );

    act(() => host.push({ type: "ended" }));
    expect(liveRegion()?.textContent).toBe("Live session ended.");
  });

  it("announces new agents at most once per interval", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const host = scriptedHost();
    renderApp(host);
    await showLiveModel(host);
    const base = makeModel();
    const withAgents = (count: number): ReplayModel => {
      const [main, ...subagents] = base.agents;
      const template = subagents[1] as ReplaySubagent;
      const extra = Array.from({ length: count }, (_, i): ReplaySubagent => ({
        ...template,
        id: `a${i + 3}`,
        callsign: `gizmo-${i}`,
      }));
      return { ...base, agents: [main, ...subagents, ...extra] };
    };
    act(() => host.push(replayUpdate(withAgents(1))));
    expect(liveRegion()?.textContent).toBe("1 new agent in the live session, 4 in total.");
    now += 1_000;
    act(() => host.push(replayUpdate(withAgents(2))));
    expect(liveRegion()?.textContent).toBe("1 new agent in the live session, 4 in total.");
    now += 10_000;
    act(() => host.push(replayUpdate(withAgents(3))));
    expect(liveRegion()?.textContent).toBe("2 new agents in the live session, 6 in total.");
  });

  it("is in the page before anything loads, so later text is announced", () => {
    renderApp(scriptedHost([]));
    expect(liveRegion()).not.toBeNull();
  });
});

describe("reduced motion and editor tabs", () => {
  it("the reduced-motion hook works without MutationObserver and follows the media query", () => {
    vi.stubGlobal("MutationObserver", undefined);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      const { result } = renderHook(() => usePrefersReducedMotion());
      expect(result.current).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the reduced-motion hook re-renders when the editor class changes", async () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => document.body.classList.add(EDITOR_REDUCED_MOTION_CLASS));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("the editor's reduce-motion class stops autoplay and asks the renderer for still frames", async () => {
    document.body.classList.add(EDITOR_REDUCED_MOTION_CLASS);
    const orrery = fakeOrrery();
    renderApp(createDemoTransport(), { start: { paused: false }, orrery });
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
    // No autoplay, so the renderer's effect can run after the list is in the DOM (issue 194).
    await rendererCreated(orrery);
    expect(orrery.calls[0]).toEqual({ method: "create", args: [{ reducedMotion: true }] });
  });

  it("works without matchMedia and ResizeObserver", async () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("ResizeObserver", undefined);
    try {
      const frames = manualFrames();
      render(
        <OrreryFactoryContext.Provider value={fakeOrrery().factory}>
          <App transport={createDemoTransport()} frames={frames} />
        </OrreryFactoryContext.Provider>,
      );
      await screen.findByRole("list", { name: "Agents" });
      expect(screen.getByRole("table", { name: /Agents in the orrery/ })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
