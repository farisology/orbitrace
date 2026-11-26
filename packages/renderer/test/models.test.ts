import type { ReplayModel } from "@orbitrace/core";
import schema from "@orbitrace/core/schema/replay-v1.schema.json" with { type: "json" };
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import minimal from "../../../fixtures/replays/minimal.replay.json" with { type: "json" };
import { createDemoModel, snapshotAt } from "../demo/demo-model.js";
import { drawFrame } from "../src/draw.js";
import { computeLayout } from "../src/layout.js";
import { createResources } from "../src/resources.js";
import { buildScene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME } from "../src/theme.js";
import { computeFrameState, createFrameState } from "../src/timeline.js";
import { MockContext, mockSurfaces } from "./support/mock-context.js";
import { smallModel } from "./support/models.js";

const ajv = new Ajv2020({ strict: true, strictTuples: false, allowUnionTypes: true });
const validate = ajv.compile(schema);

/** Draw `steps` frames across the whole model; return totals at the end. */
function playThrough(model: ReplayModel, steps = 50) {
  const scene = buildScene(model);
  const layout = computeLayout(scene, 1200, 800);
  const frame = createFrameState(scene);
  const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
  const ctx = new MockContext(false);
  for (let k = 0; k <= steps; k++) {
    computeFrameState(
      scene,
      (scene.duration * k) / steps,
      { speed: 8, minVisibleCallSeconds: 0.3, reducedMotion: false },
      frame,
    );
    drawFrame(
      ctx.asDrawContext(),
      scene,
      layout,
      frame,
      { selected: 1, hovered: -1, ambient: k / 60, dpr: 1 },
      res,
    );
  }
  return frame;
}

describe("synthetic models", () => {
  it("the hand-built test model and the demo models are valid v1 replays", () => {
    for (const model of [
      smallModel(),
      createDemoModel(),
      createDemoModel({ live: true, waves: 2 }),
    ]) {
      const ok = validate(model);
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });

  it("createDemoModel is deterministic for a seed", () => {
    expect(createDemoModel({ seed: 3 })).toEqual(createDemoModel({ seed: 3 }));
    expect(createDemoModel({ seed: 3 })).not.toEqual(createDemoModel({ seed: 4 }));
    const live = createDemoModel({ live: true });
    expect(live.agents.at(-1)!.end).toBeNull();
    expect(live.agents[0].end).toBeNull();
  });

  it("plays the repository's minimal fixture to the end with totals matching the file", () => {
    const model = minimal as unknown as ReplayModel;
    expect(validate(model)).toBe(true);
    const frame = playThrough(model);
    expect(frame.toolsStarted).toBe(model.totals.toolCalls);
    expect(frame.toolsFailed).toBe(model.totals.failedToolCalls);
    expect(frame.outputTokens).toBe(model.totals.outputTokens);
  });

  it("plays a demo session to the end with totals matching the model", () => {
    const model = createDemoModel({ waves: 3, agentsPerWave: 6 });
    const frame = playThrough(model, 200);
    expect(frame.toolsStarted).toBe(model.totals.toolCalls);
    expect(frame.toolsFailed).toBe(model.totals.failedToolCalls);
    expect(frame.outputTokens).toBe(model.totals.outputTokens);
  });

  it("snapshotAt makes valid live snapshots that only grow", () => {
    const full = createDemoModel({ waves: 2, agentsPerWave: 4 });
    let previous = snapshotAt(full, 0);
    expect(previous.agents).toHaveLength(1);
    for (const now of [15, 40, 120, 200, full.totals.duration]) {
      const snap = snapshotAt(full, now);
      expect(validate(snap)).toBe(true);
      expect(snap.totals.duration).toBe(now);
      expect(snap.agents.length).toBeGreaterThanOrEqual(previous.agents.length);
      previous.agents.forEach((agent, i) => {
        expect(snap.agents[i]!.id).toBe(agent.id);
        expect(snap.agents[i]!.tools.length).toBeGreaterThanOrEqual(agent.tools.length);
      });
      expect(snap.agents.every((a) => a.tools.every((t) => t.end === null || t.end <= now))).toBe(
        true,
      );
      previous = snap;
    }
    expect(previous.agents).toHaveLength(full.agents.length);
  });
});
