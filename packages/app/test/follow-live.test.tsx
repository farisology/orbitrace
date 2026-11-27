// Follow live (#127) end to end in the app: a fake host pushes growing snapshots that the real
// `buildReplay` made from a synthetic transcript, and a test frame scheduler drives the clock.
// Every value is invented.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toRealSeconds, type ReplayModel } from "@orbitrace/core";
import { App } from "../src/App";
import { FOLLOW_ANNOUNCEMENTS } from "../src/announce";
import { FOLLOW_CATCH_UP_MAX_SECONDS } from "../src/clock";
import { EDITOR_REDUCED_MOTION_CLASS } from "../src/reduced-motion";
import { GO_LIVE_LABEL } from "../src/components/Controls";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { createHttpTransport } from "../src/http-transport";
import type { HostTransport, LiveUpdate } from "../src/transport";
import { NO_START_OPTIONS, type StartOptions } from "../src/url-state";
import { createWebviewTransport } from "../src/webview-transport";
import { fakeFetch, fakeWebview, settle } from "./fake-hosts";
import {
  SUMMARY,
  fakeOrrery,
  manualFrames,
  replayUpdate,
  scriptedHost,
  type FakeOrrery,
} from "./helpers";
import { FIRST_CUT_INDEX, IDLE_GAP_OFFSETS, liveSnapshots } from "./live-snapshots";

let SNAPSHOTS: readonly ReplayModel[] = [];
let WAVES: readonly ReplayModel[] = [];

beforeAll(async () => {
  SNAPSHOTS = (await liveSnapshots("idle-gap", IDLE_GAP_OFFSETS)).snapshots;
  WAVES = (await liveSnapshots("two-waves", [20, 60, 100, 160, 400])).snapshots;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.classList.remove(EDITOR_REDUCED_MOTION_CLASS);
});

function snapshot(index: number): ReplayModel {
  const model = SNAPSHOTS[index];
  if (model === undefined) throw new Error(`no snapshot ${index}`);
  return model;
}

function renderApp(
  transport: HostTransport,
  options: { start?: Partial<StartOptions>; orrery?: FakeOrrery } = {},
) {
  const orrery = options.orrery ?? fakeOrrery();
  const frames = manualFrames();
  let now = 1000;
  const result = render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <App
        transport={transport}
        frames={frames}
        startOptions={{ ...NO_START_OPTIONS, ...options.start }}
      />
    </OrreryFactoryContext.Provider>,
  );
  /** Fire `count` frames `stepMs` apart, recording the playhead after each. */
  const runFrames = (count: number, stepMs = 100): number[] => {
    const seen: number[] = [];
    for (let i = 0; i < count; i += 1) {
      act(() => frames.fire(now));
      now += stepMs;
      seen.push(position());
    }
    return seen;
  };
  return { ...result, orrery, frames, runFrames };
}

const scrubber = () => screen.getByRole("slider", { name: "Replay position" }) as HTMLInputElement;
const position = () => Number(scrubber().value);
const playButton = () => screen.getByRole("button", { name: /^(Play|Pause)$/ });
const goLive = () => screen.getByRole("button", { name: GO_LIVE_LABEL });
const badge = () => screen.getByText(/^Live: |^Replay$/).textContent;
const liveRegion = () => document.querySelector('[aria-live="polite"][aria-atomic="true"]');

async function subscribed(host: ReturnType<typeof scriptedHost>): Promise<void> {
  await waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
}

/** Real seconds at the playhead on `model`. */
const realAt = (model: ReplayModel, t: number) => toRealSeconds(model.warps, t);

function stubReducedMotion(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** Reduced motion from either source the app reads (`reduced-motion.ts`). */
const REDUCED_MOTION_SOURCES = {
  "the media query": stubReducedMotion,
  "the editor's body class": () => document.body.classList.add(EDITOR_REDUCED_MOTION_CLASS),
} as const;

describe("opening a running session", () => {
  it("opens at the live edge with follow on", async () => {
    const host = scriptedHost();
    const { orrery } = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(1), "busy")));
    expect(position()).toBe(snapshot(1).totals.duration);
    expect(orrery.last("setTime")).toEqual([snapshot(1).totals.duration]);
    expect(badge()).toBe("Live: working, following");
    expect(playButton().textContent).toContain("Pause");
    expect(orrery.methods()).toContain("play");
    expect(goLive().getAttribute("aria-disabled")).toBe("true");
    expect(liveRegion()?.textContent).toMatch(
      new RegExp(
        `^Showing example-project: 1 agent, \\d+ tool calls?\\. ${FOLLOW_ANNOUNCEMENTS.entered}$`,
      ),
    );
  });

  it("an ended session and an unknown one open at the start, as a replay does", async () => {
    const ended = scriptedHost();
    const first = renderApp(ended);
    await subscribed(ended);
    act(() => ended.push(replayUpdate(snapshot(2), "ended")));
    expect(position()).toBe(0);
    expect(screen.queryByRole("button", { name: GO_LIVE_LABEL })).toBeNull();
    first.unmount();

    const unknown = scriptedHost();
    renderApp(unknown);
    await subscribed(unknown);
    act(() => unknown.push(replayUpdate(snapshot(2), "unknown")));
    expect(position()).toBe(0);
    expect(screen.queryByRole("button", { name: GO_LIVE_LABEL })).toBeNull();
  });

  it("a time or paused in the URL wins over follow", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(1), "busy")));
    expect(position()).toBe(0);
    expect(goLive().getAttribute("aria-disabled")).toBe("false");
    expect(badge()).toMatch(/^Live: working, \d+ min \d+ s behind$/);
  });
});

describe("following", () => {
  it("stays pinned across updates and animates each newly revealed span", async () => {
    const host = scriptedHost();
    const { orrery, runFrames, frames } = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(0), "busy")));
    // Holding at the edge needs no frames.
    expect(frames.pending()).toBe(0);
    for (let index = 1; index <= 2; index += 1) {
      const before = position();
      act(() => host.push(replayUpdate(snapshot(index), "busy")));
      const target = snapshot(index).totals.duration;
      // The playhead starts where it was, not already at the new edge.
      expect(position()).toBe(before);
      const seen = runFrames(13);
      // Moving across the span: some frames strictly between, never backwards, ending at the edge.
      expect(seen.some((t) => t > before && t < target)).toBe(true);
      for (let i = 1; i < seen.length; i += 1) {
        expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number);
      }
      expect(seen[seen.length - 1]).toBe(target);
      // Within about a second of wall time (frames are 100 ms apart, the first sets the start).
      const reached = seen.indexOf(target);
      expect(reached).toBeLessThanOrEqual(FOLLOW_CATCH_UP_MAX_SECONDS * 10 + 1);
      expect(badge()).toBe("Live: working, following");
      expect(frames.pending()).toBe(0);
    }
    // The renderer was given the in-between times, so the new calls are drawn happening.
    const times = orrery.calls.filter((c) => c.method === "setTime").map((c) => c.args[0]);
    expect(new Set(times).size).toBeGreaterThan(10);
    expect(orrery.methods().filter((m) => m === "setModel")).toHaveLength(1);
  });

  it("never moves backwards in real time across a new idle cut", async () => {
    expect(snapshot(FIRST_CUT_INDEX - 1).warps).toHaveLength(0);
    expect(snapshot(FIRST_CUT_INDEX).warps.length).toBeGreaterThan(0);
    const host = scriptedHost();
    const { runFrames } = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(0), "busy")));
    let lastReal = realAt(snapshot(0), position());
    let lastEdge = snapshot(0).totals.realDuration;
    for (let index = 1; index < SNAPSHOTS.length; index += 1) {
      const model = snapshot(index);
      act(() => host.push(replayUpdate(model, "busy")));
      const after = [position(), ...runFrames(13)];
      for (const t of after) {
        const real = realAt(model, t);
        expect(real).toBeGreaterThanOrEqual(lastReal);
        lastReal = real;
      }
      expect(model.totals.realDuration).toBeGreaterThanOrEqual(lastEdge);
      lastEdge = model.totals.realDuration;
      expect(position()).toBe(model.totals.duration);
    }
  });

  it("jumps instead of animating under reduced motion", async () => {
    stubReducedMotion();
    const host = scriptedHost();
    const { frames, orrery } = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(1), "busy")));
    expect(orrery.calls[0]?.args[0]).toEqual({ reducedMotion: true });
    expect(badge()).toBe("Live: working, following");
    act(() => host.push(replayUpdate(snapshot(FIRST_CUT_INDEX), "busy")));
    expect(position()).toBe(snapshot(FIRST_CUT_INDEX).totals.duration);
    expect(frames.pending()).toBe(0);
  });

  it("keeps the selection and the focus across updates, and adds new agents", async () => {
    const host = scriptedHost();
    const { runFrames } = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(WAVES[1] as ReplayModel, "busy")));
    const lanes = () => screen.getByRole("list", { name: "Agents" });
    const mainLane = within(lanes()).getByRole("button", { name: /^main/ });
    fireEvent.click(mainLane);
    mainLane.focus();
    for (const model of WAVES.slice(2, 4)) {
      act(() => host.push(replayUpdate(model, "busy")));
      runFrames(13);
    }
    expect(within(lanes()).getAllByRole("listitem")).toHaveLength(
      (WAVES[3] as ReplayModel).agents.length,
    );
    expect(
      within(lanes()).getByRole("button", { name: /^main/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.activeElement).toBe(within(lanes()).getByRole("button", { name: /^main/ }));
    expect(badge()).toBe("Live: working, following");
  });
});

describe("leaving and returning", () => {
  async function followingApp() {
    const host = scriptedHost();
    const app = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(1), "busy")));
    return { host, ...app };
  }

  it("scrubbing leaves follow, keeps the real moment on updates, and Go live returns", async () => {
    const { host } = await followingApp();
    fireEvent.change(scrubber(), { target: { value: "2" } });
    expect(badge()).toMatch(/^Live: working, 4 min \d+ s behind$/);
    expect(goLive().getAttribute("aria-disabled")).toBe("false");
    expect(liveRegion()?.textContent).toBe(FOLLOW_ANNOUNCEMENTS.left);
    for (const index of [2, FIRST_CUT_INDEX, FIRST_CUT_INDEX + 1]) {
      act(() => host.push(replayUpdate(snapshot(index), "busy")));
      expect(position()).toBe(2);
    }
    // Behind by real time, the idle gap included.
    expect(badge()).toMatch(/^Live: working, 51 min \d+ s behind$/);
    fireEvent.click(goLive());
    expect(position()).toBe(snapshot(FIRST_CUT_INDEX + 1).totals.duration);
    expect(badge()).toBe("Live: working, following");
    expect(liveRegion()?.textContent).toBe(FOLLOW_ANNOUNCEMENTS.entered);
  });

  it("stepping back leaves follow and End returns to the edge", async () => {
    await followingApp();
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(position()).toBeCloseTo(snapshot(1).totals.duration - 5);
    // Whole seconds, rounded down (floating point may make 5 s read as 4 s).
    expect(badge()).toMatch(/^Live: working, [45] s behind$/);
    fireEvent.keyDown(document.body, { key: "End" });
    expect(position()).toBe(snapshot(1).totals.duration);
    expect(badge()).toBe("Live: working, following");
    // Home leaves follow too.
    fireEvent.keyDown(document.body, { key: "Home" });
    expect(position()).toBe(0);
    expect(badge()).toMatch(/behind$/);
  });

  it("pausing leaves follow; playing forward into the edge re-enters it", async () => {
    const { runFrames } = await followingApp();
    fireEvent.click(playButton());
    expect(playButton().textContent).toContain("Play");
    expect(badge()).toBe("Live: working, not following");
    fireEvent.change(scrubber(), { target: { value: String(snapshot(1).totals.duration - 3) } });
    fireEvent.click(playButton());
    expect(badge()).toMatch(/^Live: working, [23] s behind$/);
    runFrames(8);
    expect(position()).toBe(snapshot(1).totals.duration);
    expect(badge()).toBe("Live: working, following");
    expect(liveRegion()?.textContent).toBe(FOLLOW_ANNOUNCEMENTS.entered);
    expect(playButton().textContent).toContain("Pause");
  });

  it("leaving follow by a seek pauses, so nothing moves until the user plays", async () => {
    const { runFrames, frames } = await followingApp();
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(playButton().textContent).toContain("Play");
    expect(frames.pending()).toBe(0);
    const at = position();
    runFrames(20);
    expect(position()).toBe(at);
    expect(badge()).toMatch(/behind$/);
  });

  describe.each(Object.entries(REDUCED_MOTION_SOURCES))(
    "under reduced motion from %s",
    (_source, turnOn) => {
      it.each([
        ["ArrowLeft", () => fireEvent.keyDown(document.body, { key: "ArrowLeft" })],
        ["Home", () => fireEvent.keyDown(document.body, { key: "Home" })],
        ["a scrubber change", () => fireEvent.change(scrubber(), { target: { value: "2" } })],
      ])("%s while following leaves follow without starting playback", async (_name, seek) => {
        turnOn();
        const { orrery, runFrames, frames } = await followingApp();
        expect(orrery.calls[0]?.args[0]).toEqual({ reducedMotion: true });
        expect(badge()).toBe("Live: working, following");
        act(() => seek());
        expect(badge()).toMatch(/behind$/);
        expect(frames.pending()).toBe(0);
        expect(playButton().textContent).toContain("Play");
        const at = position();
        expect(at).toBeLessThan(snapshot(1).totals.duration);
        runFrames(40);
        expect(position()).toBe(at);
        expect(badge()).toMatch(/behind$/);
        // End returns to the edge with a jump, and holds there without frames.
        fireEvent.keyDown(document.body, { key: "End" });
        expect(position()).toBe(snapshot(1).totals.duration);
        expect(badge()).toBe("Live: working, following");
        expect(frames.pending()).toBe(0);
      });
    },
  );

  it("announces leaving and entering once each, not per snapshot", async () => {
    const { host, runFrames } = await followingApp();
    const texts: string[] = [];
    const region = liveRegion() as Element;
    const observer = new MutationObserver(() => texts.push(region.textContent ?? ""));
    observer.observe(region, { subtree: true, childList: true, characterData: true });
    for (const index of [2, FIRST_CUT_INDEX, FIRST_CUT_INDEX + 1]) {
      act(() => host.push(replayUpdate(snapshot(index), "busy")));
      runFrames(13);
      await settle(1);
    }
    expect(texts.filter((t) => /follow/i.test(t))).toEqual([]);
    // Each step on its own turn, so each change of the region is seen.
    for (const key of ["ArrowLeft", "ArrowLeft", "End", "End"]) {
      fireEvent.keyDown(document.body, { key });
      await settle(1);
    }
    observer.disconnect();
    expect(texts.filter((t) => /follow/i.test(t))).toEqual([
      FOLLOW_ANNOUNCEMENTS.left,
      FOLLOW_ANNOUNCEMENTS.entered,
    ]);
  });
});

describe("when the session ends", () => {
  it("follow ends and the view is a replay at its end", async () => {
    const host = scriptedHost();
    const { runFrames } = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(4), "busy")));
    const last = snapshot(SNAPSHOTS.length - 1);
    act(() => host.push(replayUpdate(last, "ended")));
    // The last span still plays in, then the clock stops at the end.
    runFrames(13);
    expect(position()).toBe(last.totals.duration);
    expect(playButton().textContent).toContain("Play");
    expect(badge()).toBe("Replay");
    expect(screen.queryByRole("button", { name: GO_LIVE_LABEL })).toBeNull();
    expect(liveRegion()?.textContent).toBe("Live session ended.");
    // An ordinary replay now: Play starts again from 0, End only seeks.
    fireEvent.keyDown(document.body, { key: "Home" });
    fireEvent.keyDown(document.body, { key: "End" });
    expect(position()).toBe(last.totals.duration);
    expect(playButton().textContent).toContain("Play");
  });

  it("a user who was behind is not moved", async () => {
    const host = scriptedHost();
    renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(4), "busy")));
    fireEvent.change(scrubber(), { target: { value: "100" } });
    // Leaving follow by a scrub pauses.
    expect(playButton().textContent).toContain("Play");
    act(() => host.push({ type: "ended" }));
    expect(position()).toBe(100);
    expect(badge()).toBe("Replay");
  });

  it("focus on Go live moves to the play button when the button goes away", async () => {
    const host = scriptedHost();
    renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(4), "busy")));
    goLive().focus();
    expect(document.activeElement).toBe(goLive());
    act(() => host.push({ type: "ended" }));
    expect(screen.queryByRole("button", { name: GO_LIVE_LABEL })).toBeNull();
    expect(document.activeElement).toBe(playButton());
  });
});

describe("when the process exits without a file change (#139)", () => {
  // The host sends the same replay again with only the live status changed.
  async function followingAt(index: number) {
    const host = scriptedHost();
    const app = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(index), "busy")));
    expect(badge()).toBe("Live: working, following");
    return { host, ...app };
  }

  it("an ended update with an unchanged replay ends follow at the edge", async () => {
    const { host, runFrames } = await followingAt(4);
    act(() => host.push(replayUpdate(snapshot(4), "ended")));
    runFrames(13);
    expect(position()).toBe(snapshot(4).totals.duration);
    expect(playButton().textContent).toContain("Play");
    expect(badge()).toBe("Replay");
    expect(screen.queryByRole("button", { name: GO_LIVE_LABEL })).toBeNull();
    expect(liveRegion()?.textContent).toBe("Live session ended.");
  });

  it("a catch-up under way finishes before the view becomes a replay", async () => {
    const { host, runFrames } = await followingAt(1);
    act(() => host.push(replayUpdate(snapshot(2), "busy")));
    act(() => host.push(replayUpdate(snapshot(2), "ended")));
    expect(position()).toBeLessThan(snapshot(2).totals.duration);
    runFrames(13);
    expect(position()).toBe(snapshot(2).totals.duration);
    expect(playButton().textContent).toContain("Play");
    expect(badge()).toBe("Replay");
  });

  it("a user who was behind is not moved, and focus on Go live moves to Play", async () => {
    const { host } = await followingAt(4);
    fireEvent.change(scrubber(), { target: { value: "100" } });
    goLive().focus();
    act(() => host.push(replayUpdate(snapshot(4), "ended")));
    expect(position()).toBe(100);
    expect(badge()).toBe("Replay");
    expect(document.activeElement).toBe(playButton());
  });
});

describe("when liveness cannot be told (status unknown, decided on #127)", () => {
  const anyBadge = () => screen.queryByText(/^Live: |^Replay$/);
  const footerText = () => document.querySelector(".app-footer")?.textContent ?? "";

  async function followingAt(index: number) {
    const host = scriptedHost();
    const app = renderApp(host);
    await subscribed(host);
    act(() => host.push(replayUpdate(snapshot(index), "busy")));
    expect(badge()).toBe("Live: working, following");
    return { host, ...app };
  }

  it("leaves follow, hides the badge and Go live, and the clock is no longer live", async () => {
    const { host, runFrames } = await followingAt(1);
    act(() => host.push(replayUpdate(snapshot(1), "unknown")));
    expect(anyBadge()).toBeNull();
    expect(screen.queryByRole("button", { name: GO_LIVE_LABEL })).toBeNull();
    expect(playButton().textContent).toContain("Play");
    expect(position()).toBe(snapshot(1).totals.duration);
    // Not live: End only seeks, and the footer no longer offers it as go live.
    expect(footerText()).not.toContain("go live");
    fireEvent.keyDown(document.body, { key: "Home" });
    fireEvent.keyDown(document.body, { key: "End" });
    expect(position()).toBe(snapshot(1).totals.duration);
    expect(playButton().textContent).toContain("Play");
    runFrames(5);
    expect(position()).toBe(snapshot(1).totals.duration);
  });

  it("a catch-up under way finishes, then the clock stops", async () => {
    const { host, runFrames } = await followingAt(1);
    act(() => host.push(replayUpdate(snapshot(2), "busy")));
    act(() => host.push(replayUpdate(snapshot(2), "unknown")));
    runFrames(13);
    expect(position()).toBe(snapshot(2).totals.duration);
    expect(playButton().textContent).toContain("Play");
    expect(anyBadge()).toBeNull();
  });

  it("focus on Go live moves to the play button when the button goes away", async () => {
    const { host } = await followingAt(1);
    goLive().focus();
    act(() => host.push(replayUpdate(snapshot(1), "unknown")));
    expect(screen.queryByRole("button", { name: GO_LIVE_LABEL })).toBeNull();
    expect(document.activeElement).toBe(playButton());
  });

  it("says once that the status can no longer be read and following stopped", async () => {
    const { host } = await followingAt(1);
    const texts: string[] = [];
    const region = liveRegion() as Element;
    const observer = new MutationObserver(() => texts.push(region.textContent ?? ""));
    observer.observe(region, { subtree: true, childList: true, characterData: true });
    act(() => host.push(replayUpdate(snapshot(1), "unknown")));
    await settle(1);
    act(() => host.push(replayUpdate(snapshot(2), "unknown")));
    await settle(1);
    act(() => host.push(replayUpdate(snapshot(2), "unknown")));
    await settle(1);
    observer.disconnect();
    expect(liveRegion()?.textContent).toBe(FOLLOW_ANNOUNCEMENTS.statusLost);
    expect(texts.filter((text) => text === FOLLOW_ANNOUNCEMENTS.statusLost)).toHaveLength(1);
    // Go live is hidden, so the "return" words are never said.
    expect(texts).not.toContain(FOLLOW_ANNOUNCEMENTS.left);
  });

  it("says nothing of the kind when the user was not following", async () => {
    const { host } = await followingAt(1);
    fireEvent.change(scrubber(), { target: { value: "2" } });
    expect(liveRegion()?.textContent).toBe(FOLLOW_ANNOUNCEMENTS.left);
    act(() => host.push(replayUpdate(snapshot(1), "unknown")));
    expect(liveRegion()?.textContent).toBe(FOLLOW_ANNOUNCEMENTS.left);
  });

  it("brings the badge and Go live back when the session runs again, without following", async () => {
    const { host, runFrames } = await followingAt(1);
    act(() => host.push(replayUpdate(snapshot(1), "unknown")));
    act(() => host.push(replayUpdate(snapshot(FIRST_CUT_INDEX + 1), "idle")));
    expect(badge()).toMatch(/^Live: idle, \d+ min \d+ s behind$/);
    expect(goLive().getAttribute("aria-disabled")).toBe("false");
    expect(footerText()).toContain("End go live");
    // Not re-entered by itself: the playhead stays where it was.
    runFrames(20);
    expect(position()).toBe(snapshot(1).totals.duration);
    expect(playButton().textContent).toContain("Play");
    // Go live returns to follow as usual.
    fireEvent.click(goLive());
    expect(position()).toBe(snapshot(FIRST_CUT_INDEX + 1).totals.duration);
    expect(badge()).toBe("Live: idle, following");
  });
});

describe("both host transports", () => {
  it("follows over the editor webview transport", async () => {
    const webview = fakeWebview();
    const transport = createWebviewTransport({ api: webview.api, events: webview.events });
    const { runFrames } = renderApp(transport);
    await waitFor(() => expect(webview.posted).toHaveLength(1));
    const list = webview.posted[0];
    await act(async () => {
      webview.reply({ kind: "result", id: list?.id, result: [SUMMARY] });
      await settle();
    });
    await waitFor(() => expect(webview.posted).toHaveLength(2));
    const subscription = webview.posted[1];
    expect(subscription?.method).toBe("subscribe");
    const send = (update: LiveUpdate) =>
      act(() =>
        webview.reply({ kind: "live", subscriptionId: subscription?.id, key: SUMMARY.key, update }),
      );
    send(replayUpdate(snapshot(1), "busy"));
    await screen.findByRole("list", { name: "Agents" });
    expect(position()).toBe(snapshot(1).totals.duration);
    send(replayUpdate(snapshot(2), "idle"));
    runFrames(13);
    expect(position()).toBe(snapshot(2).totals.duration);
    expect(badge()).toBe("Live: idle, following");
    send({ type: "ended" });
    expect(badge()).toBe("Replay");
  });

  it("follows over the loopback HTTP transport", async () => {
    const server = fakeFetch();
    server.rpc = (request) => ({ kind: "result", id: request.id, result: [SUMMARY] });
    const transport = createHttpTransport({ token: "synthetic-token", fetch: server.fetch });
    const { runFrames } = renderApp(transport);
    await waitFor(() => expect(server.streams).toHaveLength(1));
    const stream = server.streams[0];
    const body = stream?.call.body as { id: number };
    const send = async (update: LiveUpdate) => {
      await act(async () => {
        stream?.send({ kind: "live", subscriptionId: body.id, key: SUMMARY.key, update });
        await settle();
      });
    };
    await send(replayUpdate(snapshot(1), "busy"));
    await screen.findByRole("list", { name: "Agents" });
    expect(position()).toBe(snapshot(1).totals.duration);
    await send(replayUpdate(snapshot(FIRST_CUT_INDEX), "busy"));
    runFrames(13);
    expect(position()).toBe(snapshot(FIRST_CUT_INDEX).totals.duration);
    expect(badge()).toBe("Live: working, following");
    await send(replayUpdate(snapshot(FIRST_CUT_INDEX + 1), "ended"));
    runFrames(13);
    expect(badge()).toBe("Replay");
    expect(position()).toBe(snapshot(FIRST_CUT_INDEX + 1).totals.duration);
  });
});
