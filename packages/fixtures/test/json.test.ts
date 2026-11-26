import { describe, expect, it } from "vitest";
import { DEFAULT_DIFFERENCE_LIMIT, describeJsonDifferences, findKeys } from "../src/index.js";

describe("describeJsonDifferences", () => {
  it("returns nothing for the same data, whatever the order of the keys", () => {
    expect(
      describeJsonDifferences({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }),
    ).toEqual([]);
    expect(describeJsonDifferences([], [])).toEqual([]);
    expect(describeJsonDifferences(null, null)).toEqual([]);
    expect(describeJsonDifferences("same", "same")).toEqual([]);
  });

  it("names the place of a value that changed and shows both values", () => {
    const committed = {
      agents: [{ id: "main", end: 12.5, tools: [{ name: "Read", failed: false }] }],
    };
    const regenerated = {
      agents: [{ id: "main", end: 13, tools: [{ name: "Grep", failed: true }] }],
    };
    expect(describeJsonDifferences(committed, regenerated)).toEqual([
      "agents[0].end: committed 12.5, regenerated 13",
      'agents[0].tools[0].name: committed "Read", regenerated "Grep"',
      "agents[0].tools[0].failed: committed false, regenerated true",
    ]);
  });

  it("tells null from zero, false and a missing key", () => {
    expect(describeJsonDifferences({ end: null }, { end: 0 })).toEqual([
      "end: committed null, regenerated 0",
    ]);
    expect(describeJsonDifferences({ end: null }, {})).toEqual([
      "end: only in the committed file (null)",
    ]);
    expect(describeJsonDifferences({}, { failed: false })).toEqual([
      "failed: only in the regenerated one (false)",
    ]);
  });

  it("counts the items of a list that grew or shrank, then compares the items both have", () => {
    expect(describeJsonDifferences({ tools: [1, 2, 3] }, { tools: [1, 5] })).toEqual([
      "tools: committed has 3 item(s), regenerated has 2",
      "tools[1]: committed 2, regenerated 5",
    ]);
  });

  it("names a list or an object instead of printing it", () => {
    expect(describeJsonDifferences({ a: [1, 2] }, { a: { b: 1 } })).toEqual([
      "a: committed a list of 2, regenerated an object with 1 key(s)",
    ]);
    expect(describeJsonDifferences({}, { warps: [{ at: 1 }] })).toEqual([
      "warps: only in the regenerated one (a list of 1)",
    ]);
  });

  it("writes the root as (root) and a key that is not a plain name in brackets", () => {
    expect(describeJsonDifferences(1, 2)).toEqual(["(root): committed 1, regenerated 2"]);
    expect(describeJsonDifferences([1], [1, 2])).toEqual([
      "(root): committed has 1 item(s), regenerated has 2",
    ]);
    expect(describeJsonDifferences({ "a b": { "c-d": 1 } }, { "a b": { "c-d": 2 } })).toEqual([
      '["a b"]["c-d"]: committed 1, regenerated 2',
    ]);
  });

  it("cuts a long value short", () => {
    const [line] = describeJsonDifferences({ name: "x".repeat(200) }, { name: "y" });
    expect(line).toBe(`name: committed "${"x".repeat(59)}..., regenerated "y"`);
  });

  it("lists at most the limit, then counts the rest", () => {
    const committed = Array.from({ length: 50 }, (_, index) => index);
    const regenerated = committed.map((value) => value + 1);
    const lines = describeJsonDifferences(committed, regenerated);
    expect(lines).toHaveLength(DEFAULT_DIFFERENCE_LIMIT + 1);
    expect(lines[0]).toBe("[0]: committed 0, regenerated 1");
    expect(lines.at(-1)).toBe(`... and ${50 - DEFAULT_DIFFERENCE_LIMIT} more difference(s)`);
    expect(describeJsonDifferences(committed, regenerated, 2)).toEqual([
      "[0]: committed 0, regenerated 1",
      "[1]: committed 1, regenerated 2",
      "... and 48 more difference(s)",
    ]);
    expect(describeJsonDifferences(committed, regenerated, 50)).toHaveLength(50);
    expect(describeJsonDifferences(committed, regenerated, 0)).toEqual([
      "... and 50 more difference(s)",
    ]);
  });
});

describe("findKeys", () => {
  it("finds a key at any depth, in document order, by its place", () => {
    const value = {
      text: "a",
      agents: [{ id: "main", tools: [{ name: "Read", input: {} }, { name: "Bash" }] }, { cwd: 1 }],
      totals: { text: 0 },
    };
    expect(findKeys(value, ["text", "input", "cwd"])).toEqual([
      "text",
      "agents[0].tools[0].input",
      "agents[1].cwd",
      "totals.text",
    ]);
  });

  it("looks at keys only, never at values", () => {
    expect(findKeys({ name: "text", list: ["cwd", "input"] }, ["text", "cwd", "input"])).toEqual(
      [],
    );
  });

  it("returns nothing for a value without objects, and for an empty key list", () => {
    expect(findKeys(null, ["text"])).toEqual([]);
    expect(findKeys("text", ["text"])).toEqual([]);
    expect(findKeys([1, [2, [3]]], ["text"])).toEqual([]);
    expect(findKeys({ text: 1 }, [])).toEqual([]);
  });

  it("keeps looking below a key it found", () => {
    expect(
      findKeys({ message: { content: [{ text: 1 }] } }, ["message", "content", "text"]),
    ).toEqual(["message", "message.content", "message.content[0].text"]);
  });
});
