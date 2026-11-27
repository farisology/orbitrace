// Tickets #190 and #191: reply details (cache writes by lifetime, a reply's own model) in the
// in-memory model only. Every session here is built by hand with invented values.
import { describe, expect, it } from "vitest";
import {
  buildReplay,
  describeReplayModelProblems,
  describeReplayProblems,
  exportReplay,
  REPLY_DETAIL_KEYS,
  replyDetailsOf,
  validateReplay,
  validateReplayModel,
  withoutReplyDetails,
  type ParsedReply,
  type ParsedSession,
  type ReplayModel,
} from "../../src/index.js";
import { allKeys, call, expectValidReplay, reply, run, session, sub } from "./helpers.js";

/** A parsed reply with a cache-write split and/or its own model. */
function detailed(
  base: ParsedReply,
  split: { readonly m5?: number; readonly h1?: number },
  model?: string | null,
): ParsedReply {
  return {
    ...base,
    ...(model === undefined ? {} : { model }),
    usage: {
      ...base.usage,
      ...(split.m5 === undefined ? {} : { cacheWrite5mTokens: split.m5 }),
      ...(split.h1 === undefined ? {} : { cacheWrite1hTokens: split.h1 }),
    },
  };
}

/** Main on Opus with one Haiku reply; a subagent with a split on every reply; one reply without. */
function mixed(): ParsedSession {
  const main = run(
    [
      detailed(reply({ id: "msg-m1", t: 0, tokens: [10, 20, 0, 300] }), { m5: 100, h1: 200 }),
      detailed(
        reply({ id: "msg-m2", t: 2, calls: ["toolu-ag1"], tokens: [5, 15, 300, 40] }),
        { m5: 40, h1: 0 },
        "claude-haiku-5-5",
      ),
      // No split recorded: stays without one.
      reply({ id: "msg-m3", t: 30, tokens: [4, 8, 340, 12] }),
    ],
    [call({ id: "toolu-ag1", name: "Agent", kind: "agent", msg: "msg-m2", t: 3, end: 20 })],
  );
  const helper = sub({
    agentId: "agent-widget",
    agentType: "widget-helper",
    parentToolUseId: "toolu-ag1",
    parentAgentId: "main",
    model: "claude-sonnet-5-5",
    run: run(
      [
        detailed(reply({ id: "msg-s1", t: 4, model: "claude-sonnet-5-5" }), { h1: 40 }),
        detailed(reply({ id: "msg-s2", t: 8, model: "<synthetic>" }), { m5: 1, h1: 2 }),
      ],
      [],
    ),
  });
  return session(main, [helper]);
}

describe("buildReplay without replyDetails", () => {
  it("writes no detail, so the model is a replay v1 exactly as before", () => {
    const model = buildReplay(mixed());
    expectValidReplay(model);
    const keys = allKeys(model);
    for (const key of ["cacheWrite5mTokens", "cacheWrite1hTokens"])
      expect(keys.has(key)).toBe(false);
    for (const agent of model.agents) {
      for (const entry of agent.replies) expect(entry).not.toHaveProperty("model");
    }
    expect(buildReplay(mixed(), { replyDetails: false })).toEqual(model);
  });
});

describe("buildReplay with replyDetails", () => {
  const model = buildReplay(mixed(), { replyDetails: true });
  const [main, helper] = model.agents;

  it("carries each recorded split and model, and leaves out what was not recorded", () => {
    expect(main.replies[0]).toMatchObject({
      cacheCreationTokens: 300,
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 200,
      model: "claude-opus-5-5",
    });
    expect(main.replies[1]).toMatchObject({
      cacheWrite5mTokens: 40,
      cacheWrite1hTokens: 0,
      model: "claude-haiku-5-5",
    });
    expect(main.replies[2]).not.toHaveProperty("cacheWrite5mTokens");
    expect(main.replies[2]).not.toHaveProperty("cacheWrite1hTokens");
    expect(helper?.replies[0]).toMatchObject({ cacheWrite1hTokens: 40 });
    expect(helper?.replies[0]).not.toHaveProperty("cacheWrite5mTokens");
    // A placeholder model fails the identifier check and is left out, as for an agent's model.
    expect(helper?.replies[1]).not.toHaveProperty("model");
  });

  it("changes nothing else: without the details it is the default build", () => {
    expect(withoutReplyDetails(model)).toEqual(buildReplay(mixed()));
    expect(main.model).toBe("claude-opus-5-5");
  });

  it("is not a replay file: validateReplay rejects it, describeReplayModelProblems accepts it", () => {
    expect(validateReplay(model)).toBe(false);
    expect(describeReplayProblems(model).join("\n")).toContain("cacheWrite5mTokens");
    expect(describeReplayModelProblems(model)).toEqual([]);
    expect(validateReplayModel(model)).toBe(true);
  });

  it("keeps the details in a live build with previous", () => {
    const first = buildReplay(mixed(), { replyDetails: true, now: Date.UTC(2030, 0, 1, 0, 0, 5) });
    const next = buildReplay(mixed(), { replyDetails: true, previous: first });
    expect(next.agents[0].replies[0]).toMatchObject({ cacheWrite1hTokens: 200 });
    expect(next.agents[0].replies).toHaveLength(3);
  });
});

describe("replyDetailsOf", () => {
  it("copies only recorded values, as whole counts", () => {
    const base = reply({ id: "msg-x", t: 0 });
    expect(replyDetailsOf({ ...base, model: null })).toEqual({});
    expect(replyDetailsOf(detailed(base, { m5: 2.9, h1: -4 }))).toEqual({
      cacheWrite5mTokens: 2,
      cacheWrite1hTokens: 0,
      model: "claude-opus-5-5",
    });
  });
});

describe("describeReplayModelProblems", () => {
  const good = (): ReplayModel => buildReplay(mixed(), { replyDetails: true });

  it("names each bad detail by pointer and never quotes its value", () => {
    const model = good() as unknown as {
      agents: { replies: Record<string, unknown>[] }[];
    };
    const target = model.agents[0]?.replies[0] as Record<string, unknown>;
    target["cacheWrite5mTokens"] = -3;
    target["cacheWrite1hTokens"] = 1.5;
    target["model"] = "PLANTED free text";
    const problems = describeReplayModelProblems(model);
    expect(problems).toEqual([
      "/agents/0/replies/0/cacheWrite5mTokens: must be a whole number of tokens, 0 or more",
      "/agents/0/replies/0/cacheWrite1hTokens: must be a whole number of tokens, 0 or more",
      "/agents/0/replies/0/model: must be a model id",
    ]);
    expect(problems.join("\n")).not.toContain("PLANTED");
    expect(validateReplayModel(model)).toBe(false);
  });

  it("still rejects any other extra property, on a reply or elsewhere", () => {
    const onReply = good() as unknown as { agents: { replies: Record<string, unknown>[] }[] };
    (onReply.agents[1]?.replies[0] as Record<string, unknown>)["text"] = "PLANTED";
    expect(describeReplayModelProblems(onReply).join("\n")).toContain('"text"');

    const onAgent = good() as unknown as { agents: Record<string, unknown>[] };
    (onAgent.agents[0] as Record<string, unknown>)["cacheWrite5mTokens"] = 1;
    expect(validateReplayModel(onAgent)).toBe(false);

    // An inherited enumerable property is seen too, as by the schema check.
    const inherited = good() as unknown as { agents: { replies: object[] }[] };
    const replies = inherited.agents[0]?.replies as object[];
    replies[0] = Object.assign(Object.create({ text: "PLANTED" }) as object, replies[0]);
    expect(validateReplayModel(inherited)).toBe(false);
  });

  it('rejects an own "__proto__" key on a reply, an agent or the root, as the v1 check does', () => {
    // JSON.parse makes "__proto__" an own data property; a plain assignment would not.
    const text = JSON.stringify(good());
    const plant = (where: "reply" | "agent" | "root", planted: string): unknown => {
      const value = JSON.parse(text) as {
        agents: { replies: Record<string, unknown>[] }[];
      } & Record<string, unknown>;
      // Insert the key as text so it reaches JSON.parse as an own property.
      const json = (inner: object): string =>
        `{"__proto__":${planted},${JSON.stringify(inner).slice(1)}`;
      if (where === "root") return JSON.parse(json(value)) as unknown;
      const agent = value.agents[0] as unknown as Record<string, unknown>;
      if (where === "agent") {
        value.agents[0] = JSON.parse(json(agent)) as (typeof value.agents)[0];
      } else {
        const replies = value.agents[0]?.replies as Record<string, unknown>[];
        replies[0] = JSON.parse(json(replies[0] as object)) as Record<string, unknown>;
      }
      return value;
    };
    for (const where of ["reply", "agent", "root"] as const) {
      for (const planted of ['"PLANTED free text / with spaces"', "{}", "[]"]) {
        const value = plant(where, planted);
        // The planted key really is an own property of the target.
        const target =
          where === "root"
            ? value
            : where === "agent"
              ? (value as { agents: unknown[] }).agents[0]
              : (value as { agents: { replies: unknown[] }[] }).agents[0]?.replies[0];
        expect(Object.prototype.hasOwnProperty.call(target, "__proto__")).toBe(true);
        expect(describeReplayProblems(value).length).toBeGreaterThan(0);
        const problems = describeReplayModelProblems(value);
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.join("\n")).not.toContain("PLANTED");
        expect(validateReplayModel(value)).toBe(false);
      }
    }
  });

  it("passes any value without the replay's outline to the v1 check", () => {
    for (const value of [null, 3, [], {}, { agents: "x" }]) {
      expect(describeReplayModelProblems(value)).toEqual(describeReplayProblems(value));
    }
  });

  it("lists exactly the keys of ReplayReplyDetails", () => {
    expect([...REPLY_DETAIL_KEYS]).toEqual(["cacheWrite5mTokens", "cacheWrite1hTokens", "model"]);
  });
});

describe("withoutReplyDetails", () => {
  it("gives a valid replay v1 and leaves its input as it was", () => {
    const model = buildReplay(mixed(), { replyDetails: true });
    const before = JSON.stringify(model);
    const plain = withoutReplyDetails(model);
    expect(validateReplay(plain)).toBe(true);
    expect(JSON.stringify(model)).toBe(before);
    expect(plain.agents[0]).not.toBe(model.agents[0]);
    expect(plain.agents[0].replies[0]).not.toBe(model.agents[0].replies[0]);
  });
});

describe("exportReplay drops the details", () => {
  it("writes the same bytes with or without them, and no detail key or value", () => {
    const withDetails = buildReplay(mixed(), { replyDetails: true });
    const plain = buildReplay(mixed());
    for (const options of [{}, { pretty: true }, { names: "opaque" as const }]) {
      const a = exportReplay(withDetails, options).data;
      expect(a).toBe(exportReplay(plain, options).data);
      for (const key of REPLY_DETAIL_KEYS.filter((k) => k !== "model")) {
        expect(a).not.toContain(key);
      }
      // Agent models stay; a reply-level model key never appears inside a reply.
      const parsed = JSON.parse(a) as ReplayModel;
      for (const agent of parsed.agents) {
        for (const entry of agent.replies) expect(Object.keys(entry)).not.toContain("model");
      }
    }
  });

  it("drops planted values too: a distinctive model id and counts never reach the text", () => {
    const model = buildReplay(mixed(), { replyDetails: true });
    const planted: ReplayModel = {
      ...model,
      agents: [
        {
          ...model.agents[0],
          replies: model.agents[0].replies.map((entry) => ({
            ...entry,
            model: "claude-planted-9-9",
            cacheWrite5mTokens: 987_654_321,
            cacheWrite1hTokens: 123_456_789,
          })),
        },
        ...model.agents.slice(1),
      ] as unknown as ReplayModel["agents"],
    };
    const text = exportReplay(planted).data;
    expect(text).not.toContain("claude-planted-9-9");
    expect(text).not.toContain("987654321");
    expect(text).not.toContain("123456789");
    expect(text).toBe(exportReplay(buildReplay(mixed())).data);
  });
});
