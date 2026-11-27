// Ticket #123: the `roundTimes` and `bucketTokens` export options, unit by unit. Invented data.
import { describe, expect, it } from "vitest";
import {
  bucketReplayTokens,
  bucketTokenCount,
  roundReplayTimes,
  roundToStep,
  validateReplay,
  type ReplayModel,
} from "../../src/index.js";
import { makeModel, mutableCopy } from "./model.js";

/** A copy of makeModel with times that are not multiples of anything. */
function oddTimes(): ReplayModel {
  const model = mutableCopy(makeModel());
  const scale = (value: unknown): unknown =>
    typeof value === "number" ? Math.round(value * 1.0371 * 1000) / 1000 : value;
  for (const agent of model.agents as Record<string, unknown>[]) {
    agent.start = scale(agent.start);
    agent.end = scale(agent.end);
    for (const t of agent.tools as Record<string, unknown>[]) {
      t.start = scale(t.start);
      t.end = scale(t.end);
    }
    for (const r of agent.replies as Record<string, unknown>[]) r.t = scale(r.t);
  }
  model.warps = [
    { at: 61.237, skipped: 300.04 },
    { at: 90.001, skipped: 0.004 },
  ];
  const totals = model.totals as Record<string, number>;
  totals.duration = 124.452;
  totals.realDuration = 124.452 + 300.04 + 0.004;
  return model as unknown as ReplayModel;
}

/** Every time in a replay, in document order, with its JSON pointer. */
function times(model: ReplayModel): [string, number | null][] {
  const out: [string, number | null][] = [];
  model.agents.forEach((agent, i) => {
    out.push([`/agents/${i}/start`, agent.start], [`/agents/${i}/end`, agent.end]);
    agent.tools.forEach((t, j) => {
      out.push([`/agents/${i}/tools/${j}/start`, t.start], [`/agents/${i}/tools/${j}/end`, t.end]);
    });
    agent.replies.forEach((r, k) => out.push([`/agents/${i}/replies/${k}/t`, r.t]));
  });
  model.warps.forEach((w, i) =>
    out.push([`/warps/${i}/at`, w.at], [`/warps/${i}/skipped`, w.skipped]),
  );
  out.push(["/totals/duration", model.totals.duration]);
  out.push(["/totals/realDuration", model.totals.realDuration]);
  return out;
}

describe("roundToStep", () => {
  it("rounds to the nearest multiple, halves up, without float noise", () => {
    expect(roundToStep(0.25, 0.1)).toBe(0.3);
    expect(roundToStep(0.249, 0.1)).toBe(0.2);
    expect(roundToStep(0.15, 0.1)).toBe(0.2);
    expect(roundToStep(12.3456, 0.01)).toBe(12.35);
    expect(roundToStep(7.4, 5)).toBe(5);
    expect(roundToStep(7.5, 5)).toBe(10);
    expect(roundToStep(0, 1)).toBe(0);
    expect(roundToStep(1.2345, 0.001)).toBe(1.235);
    for (let ms = 0; ms < 5000; ms += 7) {
      const text = String(roundToStep(ms / 1000, 0.1));
      expect(text).toMatch(/^\d+(\.\d)?$/);
    }
  });

  it("never moves a later time before an earlier one", () => {
    let previous = -1;
    for (let ms = 0; ms < 20_000; ms += 13) {
      const rounded = roundToStep(ms / 1000, 0.25);
      expect(rounded).toBeGreaterThanOrEqual(previous);
      previous = rounded;
    }
  });
});

describe("roundReplayTimes", () => {
  it("rounds every time and keeps a valid replay", () => {
    const input = oddTimes();
    const output = roundReplayTimes(input, 0.1);
    expect(validateReplay(JSON.parse(JSON.stringify(output)))).toBe(true);
    const values = times(output)
      .map(([, value]) => value)
      .filter((value): value is number => value !== null);
    expect(values.length).toBeGreaterThan(20);
    for (const value of values) {
      expect(Math.abs(value * 10 - Math.round(value * 10))).toBeLessThan(1e-9);
      expect(String(value)).toMatch(/^\d+(\.\d)?$/);
    }
  });

  it("keeps null ends, order, end after start and non-negative times", () => {
    for (const step of [0.001, 0.1, 1, 7, 60, 3600]) {
      const input = oddTimes();
      const output = roundReplayTimes(input, step);
      expect(validateReplay(JSON.parse(JSON.stringify(output)))).toBe(true);
      const before = times(input);
      const after = times(output);
      expect(after.map(([pointer, value]) => [pointer, value === null])).toEqual(
        before.map(([pointer, value]) => [pointer, value === null]),
      );
      for (const [, value] of after) expect(value ?? 0).toBeGreaterThanOrEqual(0);
      for (const agent of output.agents) {
        expect(agent.end ?? agent.start).toBeGreaterThanOrEqual(agent.start);
        let last = -1;
        for (const t of agent.tools) {
          expect(t.start).toBeGreaterThanOrEqual(agent.start);
          expect(t.start).toBeGreaterThanOrEqual(last);
          expect(t.end ?? t.start).toBeGreaterThanOrEqual(t.start);
          last = t.start;
        }
        last = -1;
        for (const r of agent.replies) {
          expect(r.t).toBeGreaterThanOrEqual(last);
          last = r.t;
        }
      }
      let at = -1;
      for (const w of output.warps) {
        expect(w.at).toBeGreaterThanOrEqual(at);
        expect(w.skipped).toBeGreaterThanOrEqual(step);
        at = w.at;
      }
    }
  });

  it("keeps a cut gap at one step or more and realDuration equal to its parts", () => {
    const output = roundReplayTimes(oddTimes(), 1);
    expect(output.warps).toEqual([
      { at: 61, skipped: 300 },
      { at: 90, skipped: 1 },
    ]);
    expect(output.totals.duration).toBe(124);
    expect(output.totals.realDuration).toBe(124 + 300 + 1);
  });

  it("changes nothing else and leaves the input as it was", () => {
    const input = oddTimes();
    const before = JSON.stringify(input);
    const output = roundReplayTimes(input, 0.5);
    expect(JSON.stringify(input)).toBe(before);
    const strip = (model: ReplayModel): string =>
      JSON.stringify(model).replace(
        /"(start|end|t|at|skipped|duration|realDuration)":(null|[0-9.e+-]+)/g,
        "",
      );
    expect(strip(output)).toBe(strip(input));
  });
});

describe("bucketTokenCount", () => {
  it("maps 0 to 0 and anything else to the nearest 1-2-5 value by ratio", () => {
    const cases: [number, number][] = [
      [0, 0],
      [-3, 0],
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 5],
      [7, 5],
      [8, 10],
      [14, 10],
      [15, 20],
      [31, 20],
      [32, 50],
      [70, 50],
      [71, 100],
      [140, 100],
      [150, 200],
      [4000, 5000],
      [123_456, 100_000],
      [987_654_321, 1_000_000_000],
    ];
    expect(cases.map(([count]) => [count, bucketTokenCount(count)])).toEqual(cases);
  });

  it("is within a factor of 1.6 and never decreases as the count grows", () => {
    let previous = 0;
    for (let count = 1; count < 100_000; count += 17) {
      const bucket = bucketTokenCount(count);
      expect(Math.max(bucket / count, count / bucket)).toBeLessThan(1.6);
      expect(bucket).toBeGreaterThanOrEqual(previous);
      expect(String(bucket)).toMatch(/^[125]0*$/);
      previous = bucket;
    }
  });
});

describe("bucketReplayTokens", () => {
  it("buckets reply counts and recomputes token totals from them", () => {
    const output = bucketReplayTokens(makeModel());
    expect(validateReplay(JSON.parse(JSON.stringify(output)))).toBe(true);
    const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;
    for (const agent of output.agents) {
      for (const reply of agent.replies) {
        for (const key of keys) expect(String(reply[key])).toMatch(/^(0|[125]0*)$/);
      }
      for (const key of keys) {
        expect(agent.totals[key]).toBe(agent.replies.reduce((sum, r) => sum + r[key], 0));
      }
    }
    for (const key of keys) {
      expect(output.totals[key]).toBe(output.agents.reduce((sum, a) => sum + a.totals[key], 0));
    }
    expect(output.agents[0].replies[0]).toEqual({
      t: 0.5,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 5000,
    });
  });

  it("keeps counts of agents, calls, failures and replies, and leaves the input as it was", () => {
    const input = makeModel();
    const before = JSON.stringify(input);
    const output = bucketReplayTokens(input);
    expect(JSON.stringify(input)).toBe(before);
    for (const key of ["agents", "toolCalls", "failedToolCalls", "replies"] as const) {
      expect(output.totals[key]).toBe(input.totals[key]);
    }
    const strip = (model: ReplayModel): string =>
      JSON.stringify(model).replace(/"(input|output|cacheRead|cacheCreation)Tokens":\d+/g, "");
    expect(strip(output)).toBe(strip(input));
  });
});
