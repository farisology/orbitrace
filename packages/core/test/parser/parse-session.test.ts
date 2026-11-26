import { describe, expect, expectTypeOf, it } from "vitest";
import {
  parseSession,
  type ParseSession,
  type ParsedSession,
  type SessionInput,
} from "../../src/index.js";
import {
  CONTENT_MARKER,
  assistant,
  asyncLines,
  at,
  iso,
  other,
  toolResult,
  toolUse,
  userPrompt,
  userResults,
} from "./synthetic.js";

function mainOnly(lines: readonly string[]): SessionInput {
  return { main: lines, subagents: [] };
}

async function parseMain(lines: readonly string[]): Promise<ParsedSession> {
  return parseSession(mainOnly(lines));
}

describe("parseSession", () => {
  it("matches the ParseSession signature", () => {
    expectTypeOf(parseSession).toEqualTypeOf<ParseSession>();
  });

  describe("merging lines of one reply", () => {
    const split = [
      assistant({
        time: "00:01",
        id: "msg_split",
        model: "claude-opus-5-5",
        effort: "xhigh",
        usage: { input: 5, output: 2, cacheRead: 300, cacheCreation: 0 },
        content: [toolUse("toolu_a", "Read")],
      }),
      other("internal-trace-demo", { time: "00:02" }),
      assistant({
        time: "00:03",
        id: "msg_split",
        usage: { input: 4, output: 80, cacheRead: 0, cacheCreation: 9 },
        content: [toolUse("toolu_b", "Grep"), toolUse("toolu_a", "Read")],
      }),
      assistant({
        time: "00:04",
        id: "msg_split",
        usage: { input: 5, output: 75, cacheRead: 300, cacheCreation: 9 },
        content: [toolUse("toolu_c", "Edit")],
      }),
    ];

    it("takes the maximum of each usage field, not the sum", async () => {
      const [reply] = (await parseMain(split)).main.replies;
      expect(reply?.usage).toEqual({
        inputTokens: 5,
        outputTokens: 80,
        cacheReadTokens: 300,
        cacheCreationTokens: 9,
      });
    });

    it("takes the union of tool_use blocks by block id, in first-seen order", async () => {
      const session = await parseMain(split);
      expect(session.main.replies).toHaveLength(1);
      expect(session.main.replies[0]?.toolUseIds).toEqual(["toolu_a", "toolu_b", "toolu_c"]);
      expect(session.main.toolCalls.map((call) => call.toolUseId)).toEqual([
        "toolu_a",
        "toolu_b",
        "toolu_c",
      ]);
      expect(session.main.toolCalls.every((call) => call.messageId === "msg_split")).toBe(true);
    });

    it("records line count, first and last time, and the first model and effort", async () => {
      const [reply] = (await parseMain(split)).main.replies;
      expect(reply).toMatchObject({
        lineCount: 3,
        firstAt: at("00:01"),
        lastAt: at("00:04"),
        model: "claude-opus-5-5",
        effort: "xhigh",
      });
    });

    it("starts each call at the line where its block first appeared", async () => {
      const calls = (await parseMain(split)).main.toolCalls;
      expect(calls.map((call) => call.startedAt)).toEqual([at("00:01"), at("00:03"), at("00:04")]);
    });

    it("merges lines of one reply even when another reply comes between them", async () => {
      const session = await parseMain([
        assistant({ time: "00:01", id: "msg_x", usage: { output: 1 } }),
        assistant({ time: "00:02", id: "msg_y", usage: { output: 7 } }),
        assistant({ time: "00:03", id: "msg_x", usage: { output: 4 } }),
      ]);
      expect(
        session.main.replies.map((r) => [r.messageId, r.lineCount, r.usage.outputTokens]),
      ).toEqual([
        ["msg_x", 2, 4],
        ["msg_y", 1, 7],
      ]);
    });

    it("fills a tool name that was missing on the first line of the block", async () => {
      const session = await parseMain([
        assistant({ time: "00:01", id: "msg_n", content: [{ type: "tool_use", id: "toolu_n" }] }),
        assistant({ time: "00:02", id: "msg_n", content: [toolUse("toolu_n", "Bash")] }),
      ]);
      expect(session.main.toolCalls[0]).toMatchObject({
        name: "Bash",
        kind: "shell",
        startedAt: at("00:01"),
      });
    });
  });

  describe("pairing tool calls with results", () => {
    it("records a failed result with is_error and the duration end", async () => {
      const session = await parseMain([
        assistant({ time: "00:00", id: "msg_1", content: [toolUse("toolu_fail", "Bash")] }),
        userResults({ time: "00:07", results: [toolResult("toolu_fail", true)] }),
      ]);
      expect(session.main.toolCalls[0]).toMatchObject({
        toolUseId: "toolu_fail",
        kind: "shell",
        startedAt: at("00:00"),
        endedAt: at("00:07"),
        isError: true,
      });
    });

    it("treats a result without is_error as a success", async () => {
      const session = await parseMain([
        assistant({ time: "00:00", id: "msg_1", content: [toolUse("toolu_ok", "Read")] }),
        userResults({ time: "00:01", results: [toolResult("toolu_ok")] }),
      ]);
      expect(session.main.toolCalls[0]).toMatchObject({ endedAt: at("00:01"), isError: false });
    });

    it("leaves a call without a result open", async () => {
      const session = await parseMain([
        assistant({ time: "00:00", id: "msg_1", content: [toolUse("toolu_open", "Bash")] }),
      ]);
      expect(session.main.toolCalls[0]).toMatchObject({ endedAt: null, isError: null });
    });

    it("keeps the first result when an id has several, and ignores results with no call", async () => {
      const session = await parseMain([
        assistant({ time: "00:00", id: "msg_1", content: [toolUse("toolu_twice", "Bash")] }),
        userResults({
          time: "00:02",
          results: [toolResult("toolu_twice", false), toolResult("toolu_none", true)],
        }),
        userResults({ time: "00:09", results: [toolResult("toolu_twice", true)] }),
      ]);
      expect(session.main.toolCalls).toHaveLength(1);
      expect(session.main.toolCalls[0]).toMatchObject({ endedAt: at("00:02"), isError: false });
    });

    it("never gives a negative duration when a result is stamped before its call", async () => {
      const session = await parseMain([
        userResults({ time: "00:00", results: [toolResult("toolu_early")] }),
        assistant({ time: "00:05", id: "msg_1", content: [toolUse("toolu_early", "Read")] }),
      ]);
      expect(session.main.toolCalls[0]).toMatchObject({
        startedAt: at("00:05"),
        endedAt: at("00:05"),
      });
    });

    it("sets kind and mcpServer from the tool name", async () => {
      const session = await parseMain([
        assistant({
          time: "00:00",
          id: "msg_1",
          content: [toolUse("toolu_m", "mcp__demo-docs__search"), toolUse("toolu_o", "ToolSearch")],
        }),
      ]);
      expect(session.main.toolCalls.map((c) => [c.kind, c.mcpServer])).toEqual([
        ["mcp", "demo-docs"],
        ["other", null],
      ]);
    });
  });

  describe("unknown and malformed lines", () => {
    it("skips unknown line types and counts them by type", async () => {
      const session = await parseMain([
        userPrompt({ time: "00:00" }),
        other("future-type", { time: "00:01" }),
        other("future-type", { time: "00:02" }),
        other("another-type"),
        other(undefined),
        JSON.stringify({ type: 42 }),
        other("attachment"),
        other("ai-title"),
        other("system"),
      ]);
      expect(session.lines).toEqual({
        total: 9,
        unknownByType: { "": 2, "another-type": 1, "future-type": 2 },
        malformed: 0,
      });
      expect(session.main.userLines).toBe(1);
      expect(session.main.endedAt).toBe(at("00:02"));
    });

    it("counts a type named __proto__ as an own key without touching the prototype", async () => {
      const session = await parseMain([other("__proto__"), other("constructor")]);
      expect(Object.keys(session.lines.unknownByType)).toEqual(["__proto__", "constructor"]);
      expect(Object.getPrototypeOf(session.lines.unknownByType)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(session.lines.unknownByType, "__proto__")?.value).toBe(
        1,
      );
    });

    it("counts malformed lines and keeps parsing after them", async () => {
      const session = await parseMain([
        "{not json",
        "[]",
        "null",
        assistant({ time: "00:00", id: "msg_1", content: [toolUse("toolu_1", "Bash")] }),
        '{"type":"user"',
      ]);
      expect(session.lines.malformed).toBe(4);
      expect(session.lines.total).toBe(5);
      expect(session.main.toolCalls).toHaveLength(1);
    });

    it("never throws on lines with unexpected shapes", async () => {
      const odd = [
        { type: "assistant" },
        { type: "assistant", message: null },
        { type: "assistant", message: "text" },
        { type: "assistant", message: { id: 5, content: "text", usage: [1, 2] } },
        {
          type: "assistant",
          message: { id: "msg_odd", content: [null, 1, "x", { type: "tool_use" }] },
        },
        {
          type: "assistant",
          message: { id: "msg_odd2", usage: { input_tokens: "9", output_tokens: -4 } },
        },
        {
          type: "assistant",
          timestamp: 12,
          message: { id: "msg_odd3", content: [{ type: "tool_use", id: 3 }] },
        },
        { type: "user" },
        {
          type: "user",
          message: {
            content: [null, { type: "tool_result" }, { type: "tool_result", tool_use_id: 1 }],
          },
        },
        { type: "user", message: { content: { not: "an array" } } },
        { type: "user", timestamp: "yesterday" },
        { type: "assistant", version: 3, sessionId: {}, effort: ["high"] },
      ].map((line) => JSON.stringify(line));
      const session = await parseMain(odd);
      expect(session.lines.total).toBe(odd.length);
      expect(session.lines.malformed).toBe(0);
      expect(session.sessionId).toBeNull();
      expect(session.versionsSeen).toEqual([]);
      expect(session.main.toolCalls).toEqual([]);
      expect(session.main.replies.map((r) => r.messageId)).toEqual([
        "line-1",
        "msg_odd",
        "msg_odd2",
        "msg_odd3",
      ]);
      expect(session.main.replies.find((r) => r.messageId === "msg_odd2")?.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
    });
  });

  describe("times", () => {
    it("gives a line without a timestamp the last timestamp before it", async () => {
      const session = await parseMain([
        assistant({ time: "00:10", id: "msg_1", content: [toolUse("toolu_1", "Bash")] }),
        assistant({ id: "msg_2", content: [toolUse("toolu_2", "Read")] }),
        userResults({ results: [toolResult("toolu_1")] }),
      ]);
      expect(session.main.replies[1]).toMatchObject({ firstAt: at("00:10"), lastAt: at("00:10") });
      expect(session.main.toolCalls[0]?.endedAt).toBe(at("00:10"));
    });

    it("gives lines before the first timestamp that first timestamp", async () => {
      const session = await parseMain([
        assistant({ id: "msg_1", content: [toolUse("toolu_1", "Bash")] }),
        userPrompt({ time: "00:30" }),
      ]);
      expect(session.main.replies[0]?.firstAt).toBe(at("00:30"));
      expect(session.main.toolCalls[0]?.startedAt).toBe(at("00:30"));
      expect(session.main.startedAt).toBe(at("00:30"));
    });

    it("uses time 0 and null run bounds when a transcript has no timestamps", async () => {
      const session = await parseMain([
        assistant({ id: "msg_1", content: [toolUse("toolu_1", "Bash")] }),
      ]);
      expect(session.main).toMatchObject({ startedAt: null, endedAt: null });
      expect(session.main.replies[0]).toMatchObject({ firstAt: 0, lastAt: 0 });
    });

    it("sorts replies and calls by time even when lines are out of order", async () => {
      const session = await parseMain([
        assistant({ time: "00:20", id: "msg_late", content: [toolUse("toolu_late", "Bash")] }),
        assistant({ time: "00:05", id: "msg_early", content: [toolUse("toolu_early", "Bash")] }),
      ]);
      expect(session.main.replies.map((r) => r.messageId)).toEqual(["msg_early", "msg_late"]);
      expect(session.main.toolCalls.map((c) => c.toolUseId)).toEqual(["toolu_early", "toolu_late"]);
      expect(session.main).toMatchObject({ startedAt: at("00:05"), endedAt: at("00:20") });
    });
  });

  describe("message ids", () => {
    it("falls back to the line uuid when a reply has no message id", async () => {
      const session = await parseMain([
        assistant({ time: "00:00", uuid: "uuid-demo-1", content: [toolUse("toolu_1", "Bash")] }),
      ]);
      expect(session.main.replies[0]?.messageId).toBe("uuid-demo-1");
      expect(session.main.toolCalls[0]?.messageId).toBe("uuid-demo-1");
    });

    it("keeps a tool_use id in the first reply that used it", async () => {
      const session = await parseMain([
        assistant({ time: "00:00", id: "msg_1", content: [toolUse("toolu_dup", "Bash")] }),
        assistant({ time: "00:01", id: "msg_2", content: [toolUse("toolu_dup", "Bash")] }),
      ]);
      expect(session.main.replies.map((r) => r.toolUseIds)).toEqual([["toolu_dup"], []]);
      expect(session.main.toolCalls).toHaveLength(1);
    });
  });

  describe("effort", () => {
    it.each(["low", "medium", "high", "xhigh", "max"])(
      "keeps the known level %s",
      async (effort) => {
        const [reply] = (await parseMain([assistant({ time: "00:00", id: "m", effort })])).main
          .replies;
        expect(reply?.effort).toBe(effort);
      },
    );

    it("gives null for an unrecognised or missing effort", async () => {
      const session = await parseMain([
        assistant({ time: "00:00", id: "m1", effort: "HIGH" }),
        assistant({ time: "00:01", id: "m2" }),
      ]);
      expect(session.main.replies.map((r) => r.effort)).toEqual([null, null]);
    });
  });

  describe("session facts", () => {
    it("takes the session id from the main transcript and lists versions in first-seen order", async () => {
      const session = await parseSession({
        main: [
          JSON.stringify({ type: "mode" }),
          userPrompt({ time: "00:00", version: "9.9.3" }),
          userPrompt({ time: "00:01", version: "9.9.1" }),
          userPrompt({ time: "00:02", version: "9.9.3" }),
        ],
        subagents: [
          {
            agentId: "demoagent09",
            meta: null,
            lines: [JSON.stringify({ type: "user", sessionId: "other-demo", version: "9.9.4" })],
          },
        ],
      });
      expect(session.runtime).toBe("claude-code");
      expect(session.sessionId).toBe("demo-session-0001");
      expect(session.versionsSeen).toEqual(["9.9.3", "9.9.1", "9.9.4"]);
    });

    it("falls back to a subagent's session id when the main transcript has none", async () => {
      const session = await parseSession({
        main: [],
        subagents: [
          {
            agentId: "demoagent09",
            meta: null,
            lines: [JSON.stringify({ type: "user", sessionId: "demo-sub" })],
          },
        ],
      });
      expect(session.sessionId).toBe("demo-sub");
      expect(session.main).toEqual({
        replies: [],
        toolCalls: [],
        userLines: 0,
        startedAt: null,
        endedAt: null,
      });
    });

    it("reads an async line source the same way as an array", async () => {
      const lines = [
        userPrompt({ time: "00:00" }),
        assistant({ time: "00:01", id: "msg_1", content: [toolUse("toolu_1", "Bash")] }),
        userResults({ time: "00:02", results: [toolResult("toolu_1")] }),
      ];
      const fromArray = await parseSession({ main: lines, subagents: [] });
      const fromAsync = await parseSession({ main: asyncLines(lines), subagents: [] });
      expect(fromAsync).toStrictEqual(fromArray);
    });

    it("reads a whole file passed as one string", async () => {
      const lines = [
        userPrompt({ time: "00:00" }),
        assistant({ time: "00:01", id: "msg_1", content: [toolUse("toolu_1", "Bash")] }),
      ];
      const whole = await parseSession({ main: [`${lines.join("\n")}\n`], subagents: [] });
      const split = await parseSession({ main: lines, subagents: [] });
      expect(whole).toStrictEqual(split);
    });

    it("passes on an error thrown by the line source itself", async () => {
      // eslint-disable-next-line require-yield
      async function* failing(): AsyncGenerator<string> {
        throw new Error("read failed");
      }
      await expect(parseSession({ main: failing(), subagents: [] })).rejects.toThrow("read failed");
    });
  });

  describe("subagent linking", () => {
    const parent = [
      assistant({
        time: "00:00",
        id: "msg_parent",
        content: [toolUse("toolu_spawn", "Agent"), toolUse("toolu_spawn_renamed", "SpawnAgentV2")],
      }),
    ];

    it("links a subagent to the parent call through the meta toolUseId", async () => {
      const session = await parseSession({
        main: parent,
        subagents: [
          {
            agentId: "demoagent01",
            meta: {
              agentType: "explorer",
              toolUseId: "toolu_spawn",
              description: `${CONTENT_MARKER}d`,
            },
            lines: [assistant({ time: "00:01", id: "msg_child", model: "claude-haiku-5" })],
          },
        ],
      });
      expect(session.main.toolCalls[0]).toMatchObject({
        toolUseId: "toolu_spawn",
        spawnedAgentId: "demoagent01",
      });
      expect(session.subagents[0]).toMatchObject({
        agentId: "demoagent01",
        agentType: "explorer",
        model: "claude-haiku-5",
        parentToolUseId: "toolu_spawn",
        parentAgentId: "main",
      });
      expect(JSON.stringify(session)).not.toContain(CONTENT_MARKER);
    });

    it("links through the call id whatever the parent tool is called", async () => {
      const session = await parseSession({
        main: parent,
        subagents: [
          { agentId: "demoagent02", meta: { toolUseId: "toolu_spawn_renamed" }, lines: [] },
        ],
      });
      expect(session.main.toolCalls[1]).toMatchObject({
        kind: "other",
        spawnedAgentId: "demoagent02",
      });
      expect(session.subagents[0]?.parentAgentId).toBe("main");
    });

    it("keeps an unlinked run when the meta is missing, not an object, or points nowhere", async () => {
      const session = await parseSession({
        main: parent,
        subagents: [
          { agentId: "demoagent03", meta: null, lines: [] },
          { agentId: "demoagent04", meta: { toolUseId: "toolu_absent" }, lines: [] },
          { agentId: "demoagent05", meta: ["odd"] as unknown as null, lines: [] },
        ],
      });
      expect(session.subagents.map((s) => [s.agentId, s.parentToolUseId, s.parentAgentId])).toEqual(
        [
          ["demoagent03", null, null],
          ["demoagent04", "toolu_absent", null],
          ["demoagent05", null, null],
        ],
      );
      expect(session.main.toolCalls.every((c) => c.spawnedAgentId === null)).toBe(true);
    });

    it("does not link a subagent to a call in its own transcript", async () => {
      const session = await parseSession({
        main: [],
        subagents: [
          {
            agentId: "demoagent06",
            meta: { toolUseId: "toolu_self" },
            lines: [
              assistant({ time: "00:00", id: "msg_s", content: [toolUse("toolu_self", "Agent")] }),
            ],
          },
        ],
      });
      expect(session.subagents[0]?.parentAgentId).toBeNull();
      expect(session.subagents[0]?.toolCalls[0]?.spawnedAgentId).toBeNull();
    });

    it("gives the call to the first subagent in input order when two claim it", async () => {
      const session = await parseSession({
        main: parent,
        subagents: [
          { agentId: "demoagent07", meta: { toolUseId: "toolu_spawn" }, lines: [] },
          { agentId: "demoagent08", meta: { toolUseId: "toolu_spawn" }, lines: [] },
        ],
      });
      expect(session.main.toolCalls[0]?.spawnedAgentId).toBe("demoagent07");
      expect(session.subagents.map((s) => s.parentAgentId)).toEqual(["main", "main"]);
    });

    it("reads meta fields defensively and falls back to the first reply's model", async () => {
      const session = await parseSession({
        main: parent,
        subagents: [
          {
            agentId: "demoagent10",
            meta: {
              agentType: 5,
              model: "",
              toolUseId: 7,
              spawnDepth: "1",
              isBuiltIn: "yes",
              finished: 1,
            } as unknown as null,
            lines: [
              assistant({ time: "00:01", id: "msg_a" }),
              assistant({ time: "00:02", id: "msg_b", model: "claude-sonnet-5" }),
            ],
          },
        ],
      });
      expect(session.subagents[0]).toMatchObject({
        agentType: null,
        model: "claude-sonnet-5",
        parentToolUseId: null,
        spawnDepth: null,
        isBuiltIn: null,
        finished: null,
      });
    });

    it("orders subagents by start time, runs without timestamps last, ties by input order", async () => {
      const session = await parseSession({
        main: [],
        subagents: [
          { agentId: "demoagent11", meta: null, lines: [] },
          { agentId: "demoagent12", meta: null, lines: [userPrompt({ time: "00:30" })] },
          { agentId: "demoagent13", meta: null, lines: [userPrompt({ time: "00:10" })] },
          { agentId: "demoagent14", meta: null, lines: [userPrompt({ time: "00:10" })] },
        ],
      });
      expect(session.subagents.map((s) => s.agentId)).toEqual([
        "demoagent13",
        "demoagent14",
        "demoagent12",
        "demoagent11",
      ]);
    });

    it("counts subagent lines in the session totals", async () => {
      const session = await parseSession({
        main: [userPrompt({ time: "00:00" })],
        subagents: [
          {
            agentId: "demoagent15",
            meta: null,
            lines: ["oops", other("future-type"), iso("00:01")],
          },
        ],
      });
      expect(session.lines).toEqual({
        total: 4,
        unknownByType: { "future-type": 1 },
        malformed: 2,
      });
    });
  });
});
