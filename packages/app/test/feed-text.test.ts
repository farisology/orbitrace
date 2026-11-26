import { replayFeed } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import { callsigns } from "../src/agent-stats";
import { describeFeedEvent, summariseNames } from "../src/feed-text";
import { DEMO, makeModel } from "./helpers";

describe("feed text", () => {
  const model = makeModel();
  const names = callsigns(model);
  const lines = replayFeed(model).map((event) => describeFeedEvent(event, names));

  it("summarises repeated tool names", () => {
    expect(summariseNames(["Bash", "Read", "Bash"])).toBe("Bash ×2, Read");
    expect(summariseNames([])).toBe("");
  });

  it("describes a dispatch", () => {
    expect(lines).toContainEqual({
      tag: "dispatch",
      text: "main dispatched 2 agents in wave 1: widget-explorer, gadget-builder",
      agent: null,
    });
  });

  it("describes a handback with output tokens", () => {
    expect(lines).toContainEqual({
      tag: "handback",
      text: "widget-explorer handed back to main (1.2k output tokens)",
      agent: "a1",
    });
  });

  it("describes grouped failures across agents", () => {
    expect(lines).toContainEqual({
      tag: "failures",
      text: "2 failed calls: Bash ×2 in main, widget-explorer",
      agent: null,
    });
  });

  it("describes an idle skip", () => {
    expect(lines).toContainEqual({
      tag: "idle",
      text: "Idle skip: 10 min cut from the timeline",
      agent: null,
    });
  });

  it("selects the agent of a single dispatch or failure", () => {
    const single = describeFeedEvent(
      { kind: "failures", t: 1, calls: [{ agent: "a2", name: "Read", t: 1 }], agents: ["a2"] },
      names,
    );
    expect(single).toEqual({
      tag: "failures",
      text: "1 failed call: Read in gadget-builder",
      agent: "a2",
    });
    const dispatch = describeFeedEvent(
      { kind: "dispatch", t: 1, parent: "main", wave: 2, agents: ["a9"] },
      names,
    );
    expect(dispatch.text).toBe("main dispatched 1 agent in wave 3: a9");
    expect(dispatch.agent).toBe("a9");
  });

  it("describes every event of the demo golden", () => {
    const demoNames = callsigns(DEMO);
    for (const event of replayFeed(DEMO)) {
      expect(describeFeedEvent(event, demoNames).text.length).toBeGreaterThan(0);
    }
  });
});
