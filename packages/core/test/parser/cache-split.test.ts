// Ticket #191: the parser reads the cache-write split by lifetime (`usage.cache_creation`) and
// keeps a missing value missing. Every line here is invented.
import { describe, expect, it } from "vitest";
import { parseSession, type ParsedReply } from "../../src/index.js";
import { asOptionalTokenCount, maxOptional } from "../../src/parser/values.js";
import { assistant } from "./synthetic.js";

function split(fiveMinutes?: unknown, oneHour?: unknown): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (fiveMinutes !== undefined) value["ephemeral_5m_input_tokens"] = fiveMinutes;
  if (oneHour !== undefined) value["ephemeral_1h_input_tokens"] = oneHour;
  return value;
}

async function replies(lines: readonly string[]): Promise<readonly ParsedReply[]> {
  const parsed = await parseSession({ main: lines, subagents: [] });
  return parsed.main.replies;
}

describe("asOptionalTokenCount and maxOptional", () => {
  it("keep a missing or unreadable count as null, never 0", () => {
    expect(asOptionalTokenCount(12)).toBe(12);
    expect(asOptionalTokenCount(0)).toBe(0);
    for (const bad of [undefined, null, -1, Number.NaN, Infinity, "5", {}]) {
      expect(asOptionalTokenCount(bad)).toBeNull();
    }
    expect(maxOptional(null, null)).toBeNull();
    expect(maxOptional(null, 3)).toBe(3);
    expect(maxOptional(4, null)).toBe(4);
    expect(maxOptional(4, 9)).toBe(9);
  });
});

describe("parseSession: cache writes by lifetime", () => {
  it("carries the split when the transcript records it", async () => {
    const [reply] = await replies([
      assistant({
        id: "msg-a",
        time: "00:01",
        model: "claude-opus-5-5",
        usage: { input: 3, output: 40, cacheCreation: 300, cacheCreationSplit: split(100, 200) },
      }),
    ]);
    expect(reply?.usage).toEqual({
      inputTokens: 3,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 300,
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 200,
    });
  });

  it("leaves both fields out when no line records the split", async () => {
    const [reply] = await replies([
      assistant({ id: "msg-a", time: "00:01", usage: { cacheCreation: 300 } }),
    ]);
    expect(reply?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 300,
    });
    expect(reply === undefined ? [] : Object.keys(reply.usage)).not.toContain("cacheWrite5mTokens");
  });

  it("merges the lines of one reply by the maximum of each lifetime", async () => {
    const [reply] = await replies([
      assistant({
        id: "msg-a",
        time: "00:01",
        usage: { cacheCreation: 120, cacheCreationSplit: split(120, 0) },
      }),
      assistant({
        id: "msg-a",
        time: "00:02",
        usage: { cacheCreation: 90, cacheCreationSplit: split(10, 80) },
      }),
      // A line of the same reply with no split: it changes nothing.
      assistant({ id: "msg-a", time: "00:03", usage: { cacheCreation: 5 } }),
    ]);
    expect(reply?.usage.cacheCreationTokens).toBe(120);
    expect(reply?.usage.cacheWrite5mTokens).toBe(120);
    expect(reply?.usage.cacheWrite1hTokens).toBe(80);
  });

  it("keeps one lifetime when only that one is recorded, and skips unreadable values", async () => {
    const [only5m, badValues, notAnObject] = await replies([
      assistant({ id: "msg-a", time: "00:01", usage: { cacheCreationSplit: split(7) } }),
      assistant({ id: "msg-b", time: "00:02", usage: { cacheCreationSplit: split(-1, "9") } }),
      assistant({ id: "msg-c", time: "00:03", usage: { cacheCreationSplit: [1, 2] } }),
    ]);
    expect(only5m?.usage.cacheWrite5mTokens).toBe(7);
    expect(only5m?.usage).not.toHaveProperty("cacheWrite1hTokens");
    expect(badValues?.usage).not.toHaveProperty("cacheWrite5mTokens");
    expect(badValues?.usage).not.toHaveProperty("cacheWrite1hTokens");
    expect(notAnObject?.usage).not.toHaveProperty("cacheWrite5mTokens");
  });

  it("keeps each reply's own model id, as before", async () => {
    const parsed = await replies([
      assistant({ id: "msg-a", time: "00:01", model: "claude-opus-5-5" }),
      assistant({ id: "msg-b", time: "00:02", model: "claude-haiku-5-5" }),
    ]);
    expect(parsed.map((reply) => reply.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });
});
