// The empty event feed's wording (#159): "Press play." only while paused. Every value is invented.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReplayModel } from "@orbitrace/core";
import { App } from "../src/App";
import { createClock } from "../src/clock";
import { EMPTY_FEED_TEXT, EventFeed, emptyFeedText } from "../src/components/EventFeed";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { ClockContext } from "../src/use-clock";
import { NO_START_OPTIONS } from "../src/url-state";
import { fakeOrrery, makeModel, replayUpdate, scriptedHost, stillFrames } from "./helpers";

/** The main agent alone, with no failed call and no idle skip: a replay with no feed events. */
function quietModel(): ReplayModel {
  const model = makeModel();
  const main = model.agents[0];
  if (main === undefined) throw new Error("no main agent");
  const tools = main.tools.filter((tool) => !tool.failed && tool.kind !== "agent");
  return {
    ...model,
    agents: [{ ...main, tools }],
    warps: [],
    totals: { ...model.totals, agents: 1, realDuration: model.totals.duration },
  };
}

const feed = () => screen.getByRole("region", { name: "Events" });

describe("emptyFeedText", () => {
  it("asks to press play only while paused before the first event", () => {
    expect(emptyFeedText(3, false)).toBe("No events yet. Press play.");
    expect(emptyFeedText(3, true)).toBe("No events yet.");
    expect(emptyFeedText(3, true, true)).toBe(EMPTY_FEED_TEXT.notYet);
    expect(emptyFeedText(3, false, true)).toBe(EMPTY_FEED_TEXT.notYetPaused);
  });

  it("says a finished replay has no events, and a running session none yet", () => {
    expect(emptyFeedText(0, false)).toBe("This replay has no events.");
    expect(emptyFeedText(0, true)).toBe(EMPTY_FEED_TEXT.noEvents);
    expect(emptyFeedText(0, false, true)).toBe("No events yet.");
    expect(emptyFeedText(0, true, true)).toBe("No events yet.");
  });
});

describe("EventFeed before the first event", () => {
  function renderFeed(model: ReplayModel) {
    const clock = createClock();
    clock.reset({ duration: model.totals.duration, time: 0, playing: false });
    render(
      <ClockContext.Provider value={clock}>
        <EventFeed model={model} onSelect={() => {}} />
      </ClockContext.Provider>,
    );
    return clock;
  }

  it("changes its text as playback starts and stops", () => {
    const clock = renderFeed(makeModel());
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.notYetPaused)).toBeDefined();
    act(() => clock.play());
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.notYet)).toBeDefined();
    expect(within(feed()).queryByText(/Press play/)).toBeNull();
    act(() => clock.pause());
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.notYetPaused)).toBeDefined();
  });

  it("says a replay with no events has none, playing or not", () => {
    const clock = renderFeed(quietModel());
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.noEvents)).toBeDefined();
    act(() => clock.play());
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.noEvents)).toBeDefined();
  });
});

describe("EventFeed in the app", () => {
  function renderApp(paused: boolean) {
    const host = scriptedHost();
    render(
      <OrreryFactoryContext.Provider value={fakeOrrery().factory}>
        <App
          transport={host}
          frames={stillFrames}
          startOptions={{ ...NO_START_OPTIONS, time: 0, paused }}
        />
      </OrreryFactoryContext.Provider>,
    );
    return host;
  }

  it("an autoplaying replay before its first event does not ask to press play", async () => {
    const host = renderApp(false);
    await waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
    act(() => host.push(replayUpdate(makeModel(), "ended")));
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.notYet)).toBeDefined();
  });

  it("a paused replay before its first event asks to press play", async () => {
    const host = renderApp(true);
    await waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
    act(() => host.push(replayUpdate(makeModel(), "ended")));
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.notYetPaused)).toBeDefined();
  });

  it("a followed session with no events yet says none yet, not that it has none", async () => {
    const host = scriptedHost();
    render(
      <OrreryFactoryContext.Provider value={fakeOrrery().factory}>
        <App transport={host} frames={stillFrames} />
      </OrreryFactoryContext.Provider>,
    );
    await waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
    act(() => host.push(replayUpdate(quietModel(), "busy")));
    expect(document.querySelector(".badge")?.textContent).toBe("Live: working, following");
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.notYet)).toBeDefined();
    // The session ends: a finished replay with no events.
    act(() => host.push(replayUpdate(quietModel(), "ended")));
    expect(within(feed()).getByText(EMPTY_FEED_TEXT.noEvents)).toBeDefined();
  });
});
