import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock, type Clock } from "../src/clock";
import { positionText } from "../src/components/Controls";
import {
  ORRERY_FAILED_MESSAGE,
  OrreryFactoryContext,
  OrreryView,
  orreryLabel,
} from "../src/components/OrreryView";
import {
  CALL_BANDS,
  CALL_LEGEND,
  CALL_TRACK_UNITS,
  CallMark,
  FAILED_CALL_BAND,
  callBand,
  callClass,
} from "../src/components/CallMark";
import { Timeline, percentAt, timeAtPointer } from "../src/components/Timeline";
import { prefersReducedMotion, usePrefersReducedMotion } from "../src/reduced-motion";
import { ClockContext, useClock, useClockDriver, useClockValue } from "../src/use-clock";
import { DEMO, fakeOrrery, makeModel, manualFrames, type FakeOrrery } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function withClock(clock: Clock, orrery?: FakeOrrery) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const inner = <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
    return orrery === undefined ? (
      inner
    ) : (
      <OrreryFactoryContext.Provider value={orrery.factory}>{inner}</OrreryFactoryContext.Provider>
    );
  };
}

describe("OrreryView", () => {
  const model = makeModel();

  it("creates the renderer with the clock state, forwards changes and cleans up", () => {
    const clock = createClock({ time: 12, playing: true, rate: 4, duration: 60 });
    const orrery = fakeOrrery();
    const onSelect = vi.fn();
    const { unmount } = render(
      <OrreryView
        model={model}
        generation={1}
        selected="a1"
        onSelect={onSelect}
        reducedMotion={false}
      />,
      { wrapper: withClock(clock, orrery) },
    );
    expect(orrery.methods().slice(0, 7)).toEqual([
      "create",
      "resize",
      "setSpeed",
      "setModel",
      "setTime",
      "select",
      "play",
    ]);
    expect(orrery.last("setTime")).toEqual([12]);
    act(() => clock.seek(30));
    expect(orrery.last("setTime")).toEqual([30]);
    act(() => clock.pause());
    expect(orrery.last("pause")).toEqual([]);
    act(() => clock.setRate(64));
    expect(orrery.last("setSpeed")).toEqual([64]);
    act(() => orrery.emit("select", { agentId: "a2" }));
    expect(onSelect).toHaveBeenCalledWith("a2");
    act(() => orrery.emit("hover", { agentId: "a2" }));
    expect(screen.getByRole("img").getAttribute("title")).toBe("gadget-builder");
    unmount();
    expect(orrery.methods()).toContain("destroy");
    const before = orrery.calls.length;
    clock.seek(5);
    expect(orrery.calls.length).toBe(before);
  });

  it("updates the model for a new snapshot and replaces it for a new replay", () => {
    const clock = createClock({ time: 0, playing: false, rate: 1, duration: 60 });
    const orrery = fakeOrrery();
    const props = { selected: null, onSelect: () => {}, reducedMotion: false } as const;
    const { rerender } = render(<OrreryView model={model} generation={1} {...props} />, {
      wrapper: withClock(clock, orrery),
    });
    const snapshot = makeModel(70);
    rerender(<OrreryView model={snapshot} generation={1} {...props} />);
    expect(orrery.last("updateModel")).toEqual([snapshot]);
    rerender(<OrreryView model={DEMO} generation={2} {...props} />);
    expect(orrery.last("setModel")).toEqual([DEMO]);
    expect(orrery.methods().filter((m) => m === "setModel")).toHaveLength(2);
    rerender(<OrreryView model={DEMO} generation={2} {...props} selected="a3" />);
    expect(orrery.last("select")).toEqual(["a3"]);
  });

  it("recreates the renderer when the motion preference changes", () => {
    const clock = createClock();
    const orrery = fakeOrrery();
    const props = { model, generation: 1, selected: null, onSelect: () => {} } as const;
    const { rerender } = render(<OrreryView {...props} reducedMotion={false} />, {
      wrapper: withClock(clock, orrery),
    });
    rerender(<OrreryView {...props} reducedMotion />);
    const creates = orrery.calls.filter((c) => c.method === "create").map((c) => c.args[0]);
    expect(creates).toEqual([{ reducedMotion: false }, { reducedMotion: true }]);
    expect(orrery.methods()).toContain("destroy");
  });

  it("says so when the renderer cannot start", () => {
    const clock = createClock();
    const failing = {
      ...fakeOrrery(),
      factory: () => {
        throw new Error("no 2D context");
      },
    };
    render(
      <OrreryView
        model={model}
        generation={1}
        selected={null}
        onSelect={() => {}}
        reducedMotion={false}
      />,
      { wrapper: withClock(clock, failing) },
    );
    expect(screen.getByRole("status").textContent).toBe(ORRERY_FAILED_MESSAGE);
  });

  it("describes the canvas in words", () => {
    expect(orreryLabel(model)).toBe(
      "Orrery: the main agent in the centre, 2 subagents in orbit, 10 tool calls. The table of agents after it lists what it shows; select an agent with the timeline lanes.",
    );
  });
});

describe("Timeline", () => {
  it("places times and reads the pointer", () => {
    expect(percentAt(30, 60)).toBe(50);
    expect(percentAt(90, 60)).toBe(100);
    expect(percentAt(-1, 60)).toBe(0);
    expect(percentAt(5, 0)).toBe(0);
    expect(timeAtPointer(150, 100, 200, 60)).toBe(15);
    expect(timeAtPointer(50, 100, 200, 60)).toBe(0);
    expect(timeAtPointer(400, 100, 200, 60)).toBe(60);
    expect(timeAtPointer(150, 100, 0, 60)).toBe(0);
  });

  it("draws one lane per agent with calls coloured by kind and failures marked", () => {
    const clock = createClock({ time: 0, playing: false, rate: 1, duration: 60 });
    const { container } = render(
      <Timeline model={makeModel()} selected="a1" onSelect={() => {}} />,
      {
        wrapper: withClock(clock),
      },
    );
    expect(container.querySelectorAll(".lane")).toHaveLength(3);
    expect(container.querySelectorAll(".lane-track .call-failed")).toHaveLength(2);
    expect(container.querySelectorAll(".lane-track .k-shell")).toHaveLength(1);
    expect(container.querySelectorAll(".lane-track .k-agent")).toHaveLength(2);
    expect(container.querySelectorAll(".warp-line")).toHaveLength(1);
    expect(container.querySelector(".lane-selected")?.textContent).toContain("widget-explorer");
  });

  it("draws each kind of call at its own height, not by colour alone (WCAG 1.4.1)", () => {
    const clock = createClock({ time: 0, playing: false, rate: 1, duration: 60 });
    const { container } = render(
      <Timeline model={makeModel()} selected={null} onSelect={() => {}} />,
      { wrapper: withClock(clock) },
    );
    const bandOf = (selector: string) =>
      Array.from(container.querySelectorAll(`.lane-track ${selector}`), (rect) => [
        Number(rect.getAttribute("y")),
        Number(rect.getAttribute("height")),
      ]);
    expect(bandOf(".k-shell")).toEqual([[0.5, 4]]);
    expect(bandOf(".k-read")).toEqual([
      [3, 4],
      [3, 4],
    ]);
    expect(bandOf(".k-mcp")).toEqual([[3, 4]]);
    expect(bandOf(".k-edit")).toEqual([
      [5.5, 4],
      [5.5, 4],
    ]);
    expect(bandOf(".k-agent")).toEqual([
      [1.5, 7],
      [1.5, 7],
    ]);
    expect(bandOf(".call-failed")).toEqual([
      [0, 10],
      [0, 10],
    ]);
  });

  it("shows a visible legend naming each mark beside a sample of it", () => {
    const clock = createClock({ time: 0, playing: false, rate: 1, duration: 60 });
    render(<Timeline model={makeModel()} selected={null} onSelect={() => {}} />, {
      wrapper: withClock(clock),
    });
    const legend = screen.getByRole("list", { name: "Tool call marks" });
    const items = Array.from(legend.querySelectorAll("li"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Shell",
      "Read, MCP, Other",
      "Edit",
      "Agent",
      "Failed",
    ]);
    for (const item of items) {
      expect(item.querySelector("svg.call-mark")?.getAttribute("aria-hidden")).toBe("true");
    }
    const failedSample = items[4]?.querySelector(".call-failed");
    expect(failedSample?.getAttribute("height")).toBe(String(FAILED_CALL_BAND.height));
  });

  it("selects and deselects with a lane label, and seeks with the pointer", () => {
    const clock = createClock({ time: 0, playing: false, rate: 1, duration: 60 });
    const onSelect = vi.fn();
    const { container, rerender } = render(
      <Timeline model={makeModel()} selected={null} onSelect={onSelect} />,
      { wrapper: withClock(clock) },
    );
    fireEvent.click(screen.getByRole("button", { name: /^gadget-builder/ }));
    expect(onSelect).toHaveBeenLastCalledWith("a2");
    rerender(<Timeline model={makeModel()} selected="a2" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /^gadget-builder/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);

    const overlay = container.querySelector(".tracks-overlay") as HTMLElement;
    overlay.getBoundingClientRect = () =>
      ({ left: 100, width: 600, top: 0, height: 50 }) as DOMRect;
    fireEvent.pointerDown(overlay, { button: 0, clientX: 400, pointerId: 1 });
    expect(clock.getState().time).toBe(30);
    fireEvent.pointerDown(overlay, { button: 2, clientX: 700, pointerId: 1 });
    expect(clock.getState().time).toBe(30);
  });

  it("moves the playhead with the clock", () => {
    const clock = createClock({ time: 0, playing: false, rate: 1, duration: 60 });
    const { container } = render(
      <Timeline model={makeModel()} selected={null} onSelect={() => {}} />,
      {
        wrapper: withClock(clock),
      },
    );
    act(() => clock.seek(15));
    expect((container.querySelector(".playhead") as HTMLElement).style.left).toBe("25%");
  });
});

describe("Controls text", () => {
  it("gives real time and real length", () => {
    expect(positionText(makeModel(), 10)).toBe("0:10 of 11:00");
    expect(positionText(makeModel(), 31)).toBe("10:31 of 11:00");
  });
});

describe("clock hooks", () => {
  it("useClock throws outside a provider", () => {
    expect(() => renderHook(() => useClock())).toThrow(/ClockContext/);
  });

  it("useClockValue re-renders only when the selected value changes", () => {
    const clock = createClock({ time: 0, playing: false, rate: 1, duration: 60 });
    let renders = 0;
    const select = (state: { time: number }) => state.time >= 30;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useClockValue(select);
      },
      { wrapper: withClock(clock) },
    );
    expect(result.current).toBe(false);
    const after = renders;
    act(() => clock.seek(10));
    expect(renders).toBe(after);
    act(() => clock.seek(40));
    expect(result.current).toBe(true);
  });

  it("useClockDriver advances the clock each frame while playing, and stops", () => {
    const clock = createClock({ time: 0, playing: false, rate: 10, duration: 60 });
    const frames = manualFrames();
    const { unmount } = renderHook(() => useClockDriver(clock, frames));
    expect(frames.pending()).toBe(0);
    act(() => clock.play());
    expect(frames.pending()).toBe(1);
    act(() => frames.fire(1000));
    act(() => frames.fire(1050));
    expect(clock.getState().time).toBeCloseTo(0.5);
    act(() => clock.pause());
    expect(frames.pending()).toBe(0);
    unmount();
  });
});

describe("reduced motion", () => {
  it("reads and follows the media query", () => {
    let matches = true;
    let onChange: (() => void) | null = null;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, listener: () => void) => {
        onChange = listener;
      },
      removeEventListener: () => {},
    }));
    expect(prefersReducedMotion()).toBe(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    matches = false;
    act(() => (onChange as unknown as () => void)());
    expect(result.current).toBe(false);
  });

  it("is false where matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("CallMark", () => {
  it("gives every kind a band inside the track and failures the whole track", () => {
    for (const band of [...Object.values(CALL_BANDS), FAILED_CALL_BAND]) {
      expect(band.y).toBeGreaterThanOrEqual(0);
      expect(band.y + band.height).toBeLessThanOrEqual(CALL_TRACK_UNITS);
    }
    expect(FAILED_CALL_BAND).toEqual({ y: 0, height: CALL_TRACK_UNITS });
    expect(callBand("edit", true)).toBe(FAILED_CALL_BAND);
    expect(callBand("edit", false)).toBe(CALL_BANDS.edit);
  });

  it("gives marks of different colours different bands, so the colour is never the only sign", () => {
    // Kinds that share a colour (read, MCP, other) share a band; every other pair differs.
    const groups = CALL_LEGEND.map((entry) => callBand(entry.kind, entry.failed));
    const keys = groups.map((band) => `${band.y}/${band.height}`);
    expect(new Set(keys).size).toBe(CALL_LEGEND.length);
    expect(CALL_BANDS.mcp).toEqual(CALL_BANDS.read);
    expect(CALL_BANDS.other).toEqual(CALL_BANDS.read);
    // The failure band is the only one that fills the track.
    for (const band of Object.values(CALL_BANDS)) {
      expect(band.height).toBeLessThan(FAILED_CALL_BAND.height);
    }
  });

  it("names the colour class of a call", () => {
    expect(callClass("shell", false)).toBe("call k-shell");
    expect(callClass("shell", true)).toBe("call call-failed");
  });

  it("draws a hidden sample mark at the kind's band", () => {
    const { container } = render(<CallMark kind="agent" />);
    const svg = container.querySelector("svg.call-mark");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    const mark = container.querySelector(".k-agent");
    expect(mark?.getAttribute("y")).toBe(String(CALL_BANDS.agent.y));
    expect(mark?.getAttribute("height")).toBe(String(CALL_BANDS.agent.height));
    const { container: failed } = render(<CallMark kind="read" failed />);
    expect(failed.querySelector(".call-failed")?.getAttribute("height")).toBe("10");
  });
});
