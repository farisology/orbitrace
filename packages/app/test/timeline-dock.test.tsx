// The timeline dock while a followed session adds agents (#144): a fake host pushes growing
// snapshots that the real `buildReplay` made from the seeded demo scenario, so each snapshot adds
// timeline lanes. happy-dom lays nothing out, so the canvas size itself is measured in a real
// browser (ACCESSIBILITY.md) and the dock's fixed height is guarded in layout-css.test.ts; here
// the lanes get a stubbed geometry (24 px each, a 72 px tall list) to check where the list scrolls.
// Every value is invented.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayModel } from "@orbitrace/core";
import { App } from "../src/App";
import { createClock } from "../src/clock";
import { isInView } from "../src/lane-scroll";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { Timeline } from "../src/components/Timeline";
import type { HostTransport } from "../src/transport";
import { ClockContext } from "../src/use-clock";
import { NO_START_OPTIONS, type StartOptions } from "../src/url-state";
import { fakeOrrery, makeModel, replayUpdate, scriptedHost, stillFrames } from "./helpers";
import { liveSnapshots } from "./live-snapshots";

const LANE_HEIGHT = 24;
const LIST_PADDING = 4;
const BODY_HEIGHT = 3 * LANE_HEIGHT;

/** Snapshots of the demo session, one per agent count from 1 up: each adds lanes. */
let GROWING: readonly ReplayModel[] = [];

beforeAll(async () => {
  const offsets = Array.from({ length: 160 }, (_, i) => 2 + i * 2);
  const { snapshots } = await liveSnapshots("demo", offsets);
  const picked: ReplayModel[] = [];
  for (const model of snapshots) {
    const last = picked[picked.length - 1];
    if (last === undefined || model.agents.length > last.agents.length) picked.push(model);
  }
  GROWING = picked;
});

/**
 * Stub the layout: each `.lane` is 24 px tall below the list's 4 px padding, and the timeline
 * body shows three lanes. Everything else keeps happy-dom's zeros.
 */
function stubLaneGeometry(): void {
  const laneIndex = (element: HTMLElement) =>
    Array.prototype.indexOf.call(element.parentElement?.children ?? [], element);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("lane") ? LIST_PADDING + laneIndex(this) * LANE_HEIGHT : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("lane") ? LANE_HEIGHT : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("timeline-body") ? BODY_HEIGHT : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (!this.classList.contains("timeline-body")) return 0;
    return 2 * LIST_PADDING + this.querySelectorAll(".lane").length * LANE_HEIGHT;
  });
}

beforeEach(stubLaneGeometry);

afterEach(() => {
  vi.restoreAllMocks();
});

function growing(index: number): ReplayModel {
  const model = GROWING[index];
  if (model === undefined) throw new Error(`no snapshot ${index}`);
  return model;
}

function renderApp(transport: HostTransport, start: Partial<StartOptions> = {}) {
  const orrery = fakeOrrery();
  const result = render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <App
        transport={transport}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, ...start }}
      />
    </OrreryFactoryContext.Provider>,
  );
  return { ...result, orrery };
}

const body = () => {
  const element = document.querySelector<HTMLElement>(".timeline-body");
  if (element === null) throw new Error("no timeline body");
  return element;
};
const laneLabels = () =>
  within(screen.getByRole("list", { name: "Agents" })).getAllByRole("button");
/** The bottom edge of the last lane: where the list ends when the newest lane is shown. */
const newestLaneTop = (model: ReplayModel) =>
  LIST_PADDING + model.agents.length * LANE_HEIGHT - BODY_HEIGHT;

/** Whether the first (main) lane is wholly inside the visible part of the list. */
const mainLaneInView = () =>
  isInView(
    { scrollTop: body().scrollTop, height: BODY_HEIGHT },
    { top: LIST_PADDING, bottom: LIST_PADDING + LANE_HEIGHT },
  );

/** Scroll the list as the user would, and let the app see the scroll event. */
function userScroll(top: number): void {
  body().scrollTop = top;
  fireEvent.scroll(body());
}

async function following() {
  const host = scriptedHost();
  const app = renderApp(host);
  await vi.waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
  act(() => host.push(replayUpdate(growing(0), "busy")));
  return { host, ...app };
}

describe("growing snapshots (#144)", () => {
  it("are synthetic snapshots that add lanes one or more at a time, up to six or more", () => {
    expect(GROWING.length).toBeGreaterThanOrEqual(6);
    expect(growing(0).agents).toHaveLength(1);
    expect(growing(GROWING.length - 1).agents.length).toBeGreaterThanOrEqual(6);
    // Each snapshot keeps the agents of the one before, in order, and adds after them.
    for (let i = 1; i < GROWING.length; i += 1) {
      const before = growing(i - 1).agents.map((agent) => agent.id);
      expect(
        growing(i)
          .agents.map((agent) => agent.id)
          .slice(0, before.length),
      ).toEqual(before);
    }
  });

  it("add lanes inside the dock's scrolling body only; the orrery is never re-created or resized", async () => {
    const { host, orrery, container } = await following();
    const stage = container.querySelector(".stage");
    const canvas = container.querySelector("canvas");
    for (const model of GROWING.slice(1)) {
      act(() => host.push(replayUpdate(model, "busy")));
      expect(laneLabels()).toHaveLength(model.agents.length);
      // The stage holds the orrery only; every lane is in the dock's timeline body.
      expect(stage?.querySelector(".lane")).toBeNull();
      expect(container.querySelectorAll(".dock .timeline-body .lane")).toHaveLength(
        model.agents.length,
      );
      expect(container.querySelector(".stage")).toBe(stage);
      expect(container.querySelector("canvas")).toBe(canvas);
    }
    expect(orrery.methods().filter((method) => method === "create")).toHaveLength(1);
    expect(orrery.methods().filter((method) => method === "resize")).toHaveLength(1);
    // Newer snapshots update the model in place; only the first one set it.
    expect(orrery.methods().filter((method) => method === "setModel")).toHaveLength(1);
  });

  it("scroll the newest lane into view while following", async () => {
    const { host } = await following();
    for (const model of GROWING.slice(1)) {
      act(() => host.push(replayUpdate(model, "busy")));
      expect(body().scrollTop).toBe(Math.max(0, newestLaneTop(model)));
    }
    expect(body().scrollTop).toBeGreaterThan(0);
  });

  it("leave the lanes where the user scrolled them, until the user scrolls back to the end", async () => {
    const { host } = await following();
    const [first, second, ...rest] = GROWING.slice(1).filter((m) => newestLaneTop(m) > 0);
    if (first === undefined || second === undefined) throw new Error("too few snapshots");
    act(() => host.push(replayUpdate(first, "busy")));
    expect(body().scrollTop).toBe(newestLaneTop(first));

    userScroll(0);
    act(() => host.push(replayUpdate(second, "busy")));
    expect(body().scrollTop).toBe(0);

    // Back at the end of the list: new lanes are shown again.
    userScroll(newestLaneTop(second));
    const third = rest[0];
    if (third === undefined) throw new Error("too few snapshots");
    act(() => host.push(replayUpdate(third, "busy")));
    expect(body().scrollTop).toBe(newestLaneTop(third));
  });

  it("do not move the lanes when the view is not following", async () => {
    const { host } = await following();
    // Pausing leaves follow.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    for (const model of GROWING.slice(1)) act(() => host.push(replayUpdate(model, "busy")));
    expect(body().scrollTop).toBe(0);
  });

  it("do not do so for a session opened as a replay", async () => {
    const host = scriptedHost();
    renderApp(host);
    await vi.waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
    act(() => host.push(replayUpdate(growing(0), "unknown")));
    for (const model of GROWING.slice(1)) act(() => host.push(replayUpdate(model, "unknown")));
    expect(body().scrollTop).toBe(0);
  });

  it("keep the selected agent's lane in view", async () => {
    const { host } = await following();
    fireEvent.click(laneLabels()[0] as HTMLElement);
    for (const model of GROWING.slice(1)) {
      act(() => host.push(replayUpdate(model, "busy")));
      expect(mainLaneInView()).toBe(true);
    }
    // New lanes were shown only as far as the main lane allowed.
    expect(body().scrollTop).toBeLessThan(newestLaneTop(growing(GROWING.length - 1)));
    expect(laneLabels()[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keep the focused lane in view", async () => {
    const { host } = await following();
    (laneLabels()[0] as HTMLElement).focus();
    for (const model of GROWING.slice(1)) {
      act(() => host.push(replayUpdate(model, "busy")));
      expect(mainLaneInView()).toBe(true);
    }
    expect(body().scrollTop).toBeLessThan(newestLaneTop(growing(GROWING.length - 1)));
    expect(document.activeElement).toBe(laneLabels()[0]);
  });
});

describe("selecting an agent elsewhere", () => {
  it("scrolls its lane into view, and that scroll is not taken as the user's", async () => {
    const { host, orrery } = await following();
    const last = growing(GROWING.length - 1);
    act(() => host.push(replayUpdate(last, "busy")));
    userScroll(newestLaneTop(last));
    // Selected in the orrery: the main lane, out of view at the top.
    act(() => orrery.emit("select", { agentId: "main" }));
    expect(body().scrollTop).toBe(LIST_PADDING);
    // The scroll event of that move does not count as the user scrolling away.
    fireEvent.scroll(body());
    act(() => orrery.emit("select", { agentId: null }));
    const more = makeLaneGrowth(last);
    act(() => host.push(replayUpdate(more, "busy")));
    expect(body().scrollTop).toBe(newestLaneTop(more));
  });
});

describe("Timeline on its own", () => {
  it("starts a different replay's lanes at the top", () => {
    const clock = createClock();
    const model = makeModel();
    const view = render(
      <ClockContext.Provider value={clock}>
        <Timeline model={model} selected={null} onSelect={() => {}} generation={1} />
      </ClockContext.Provider>,
    );
    body().scrollTop = 40;
    view.rerender(
      <ClockContext.Provider value={clock}>
        <Timeline model={makeModel(90)} selected={null} onSelect={() => {}} generation={2} />
      </ClockContext.Provider>,
    );
    expect(body().scrollTop).toBe(0);
  });

  it("does nothing while the list is not laid out", () => {
    vi.restoreAllMocks();
    const clock = createClock();
    clock.reset({ duration: 60, live: true, following: true, playing: true });
    const view = render(
      <ClockContext.Provider value={clock}>
        <Timeline model={growing(0)} selected={null} onSelect={() => {}} />
      </ClockContext.Provider>,
    );
    view.rerender(
      <ClockContext.Provider value={clock}>
        <Timeline model={growing(GROWING.length - 1)} selected={null} onSelect={() => {}} />
      </ClockContext.Provider>,
    );
    expect(body().scrollTop).toBe(0);
  });
});

/** `model` with one more synthetic subagent at the end, as a later snapshot would add. */
function makeLaneGrowth(model: ReplayModel): ReplayModel {
  const template = model.agents[model.agents.length - 1];
  if (template === undefined || template.parent === null) throw new Error("no subagent");
  const added = { ...template, id: "a999" as const, name: "extra-lane", callsign: "extra-lane" };
  return {
    ...model,
    agents: [...model.agents, added],
    totals: { ...model.totals, agents: model.agents.length + 1 },
  };
}
