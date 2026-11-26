/**
 * Golden test: one synthetic session with a main transcript and three subagent runs,
 * parsed into the full expected `ParsedSession`.
 */

import { describe, expect, it } from "vitest";
import {
  parseSession,
  type ParsedSession,
  type RawSubagentMeta,
  type SessionInput,
} from "../../src/index.js";
import {
  CONTENT_MARKER,
  SESSION_ID,
  assistant,
  asyncLines,
  at,
  other,
  text,
  thinking,
  toolResult,
  toolUse,
  userPrompt,
  userResults,
} from "./synthetic.js";

const MAIN: readonly string[] = [
  // Known type with no timestamp: counted, not unknown.
  JSON.stringify({ type: "file-history-snapshot", snapshot: { files: [] } }),
  userPrompt({ time: "00:00" }),
  // One reply written over three lines that share a message id.
  assistant({
    time: "00:02",
    id: "msg_main_1",
    model: "claude-opus-5-5",
    effort: "high",
    usage: { input: 10, output: 1, cacheRead: 100, cacheCreation: 5 },
    content: [thinking()],
  }),
  assistant({
    time: "00:03",
    id: "msg_main_1",
    model: "claude-opus-5-5",
    effort: "high",
    usage: { input: 10, output: 40, cacheRead: 100, cacheCreation: 5 },
    content: [toolUse("toolu_main_read", "Read")],
  }),
  assistant({
    time: "00:04",
    id: "msg_main_1",
    model: "claude-opus-5-5",
    effort: "high",
    usage: { input: 12, output: 35, cacheRead: 90, cacheCreation: 7 },
    content: [toolUse("toolu_main_agent", "Agent"), toolUse("toolu_main_read", "Read")],
  }),
  other("internal-trace-demo", { time: "00:05" }),
  '{"type":"assistant","message":{"id":"msg_broken"',
  userResults({ time: "00:06", results: [toolResult("toolu_main_read", false)] }),
  assistant({
    time: "01:00",
    version: "9.9.2",
    id: "msg_main_2",
    model: "claude-opus-5-5",
    effort: "turbo",
    usage: { input: 3, output: 9 },
    content: [
      text(),
      toolUse("toolu_main_bash", "Bash"),
      toolUse("toolu_main_mcp", "mcp__demo-server__lookup"),
    ],
  }),
  userResults({
    time: "01:03",
    version: "9.9.2",
    results: [toolResult("toolu_main_bash", true), toolResult("toolu_main_mcp")],
  }),
  userResults({
    time: "02:30",
    version: "9.9.2",
    results: [toolResult("toolu_main_agent", false)],
  }),
  other(undefined, { time: "02:31" }),
  assistant({
    time: "02:35",
    version: "9.9.2",
    id: "msg_main_3",
    model: "claude-opus-5-5",
    effort: "max",
    usage: { output: 20 },
  }),
  "[1, 2, 3]",
  "",
];

const REVIEWER_META: RawSubagentMeta = {
  agentType: "code-reviewer",
  model: "claude-sonnet-5",
  toolUseId: "toolu_main_agent",
  spawnDepth: 1,
  description: `${CONTENT_MARKER}review the widget`,
  isBuiltIn: false,
  finished: true,
};

const REVIEWER: readonly string[] = [
  userPrompt({ time: "00:10" }),
  assistant({
    time: "00:12",
    id: "msg_rev_1",
    model: "claude-sonnet-5",
    effort: "medium",
    usage: { input: 4, output: 12, cacheRead: 50 },
    content: [toolUse("toolu_rev_grep", "Grep"), toolUse("toolu_rev_task", "Task")],
  }),
  userResults({ time: "00:13", results: [toolResult("toolu_rev_grep")] }),
  userResults({ time: "02:00", results: [toolResult("toolu_rev_task", false)] }),
  assistant({
    time: "02:20",
    id: "msg_rev_2",
    model: "claude-sonnet-5",
    usage: { output: 6 },
    content: [toolUse("toolu_rev_handback", "SubagentHandback")],
  }),
];

const NESTED_META: RawSubagentMeta = {
  agentType: "test-writer",
  toolUseId: "toolu_rev_task",
  spawnDepth: 2,
  description: `${CONTENT_MARKER}write tests`,
};

const NESTED: readonly string[] = [
  assistant({
    time: "00:20",
    id: "msg_nested_1",
    model: "claude-haiku-5",
    effort: "low",
    usage: { input: 1, output: 2 },
    content: [toolUse("toolu_nested_edit", "Edit"), toolUse("toolu_nested_write", "Write")],
  }),
  userResults({
    time: "00:25",
    results: [toolResult("toolu_nested_edit", false), toolResult("toolu_nested_write", false)],
  }),
];

// No meta file, and a parent that does not exist anywhere: kept, not linked.
const ORPHAN: readonly string[] = [
  other("mystery-line"),
  assistant({
    time: "00:01",
    id: "msg_orphan_1",
    usage: { output: 3 },
    content: [toolUse("toolu_orphan_glob", "Glob")],
  }),
];

function makeInput(): SessionInput {
  return {
    main: MAIN,
    subagents: [
      { agentId: "demoagent01", meta: REVIEWER_META, lines: asyncLines(REVIEWER) },
      { agentId: "demoagent02", meta: NESTED_META, lines: NESTED },
      { agentId: "demoagent03", meta: null, lines: ORPHAN },
    ],
  };
}

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
});

const EXPECTED: ParsedSession = {
  runtime: "claude-code",
  sessionId: SESSION_ID,
  main: {
    replies: [
      {
        messageId: "msg_main_1",
        model: "claude-opus-5-5",
        effort: "high",
        firstAt: at("00:02"),
        lastAt: at("00:04"),
        usage: usage(12, 40, 100, 7),
        toolUseIds: ["toolu_main_read", "toolu_main_agent"],
        lineCount: 3,
      },
      {
        messageId: "msg_main_2",
        model: "claude-opus-5-5",
        effort: null,
        firstAt: at("01:00"),
        lastAt: at("01:00"),
        usage: usage(3, 9),
        toolUseIds: ["toolu_main_bash", "toolu_main_mcp"],
        lineCount: 1,
      },
      {
        messageId: "msg_main_3",
        model: "claude-opus-5-5",
        effort: "max",
        firstAt: at("02:35"),
        lastAt: at("02:35"),
        usage: usage(0, 20),
        toolUseIds: [],
        lineCount: 1,
      },
    ],
    toolCalls: [
      {
        toolUseId: "toolu_main_read",
        name: "Read",
        mcpServer: null,
        kind: "read",
        messageId: "msg_main_1",
        startedAt: at("00:03"),
        endedAt: at("00:06"),
        isError: false,
        spawnedAgentId: null,
      },
      {
        toolUseId: "toolu_main_agent",
        name: "Agent",
        mcpServer: null,
        kind: "agent",
        messageId: "msg_main_1",
        startedAt: at("00:04"),
        endedAt: at("02:30"),
        isError: false,
        spawnedAgentId: "demoagent01",
      },
      {
        toolUseId: "toolu_main_bash",
        name: "Bash",
        mcpServer: null,
        kind: "shell",
        messageId: "msg_main_2",
        startedAt: at("01:00"),
        endedAt: at("01:03"),
        isError: true,
        spawnedAgentId: null,
      },
      {
        toolUseId: "toolu_main_mcp",
        name: "mcp__demo-server__lookup",
        mcpServer: "demo-server",
        kind: "mcp",
        messageId: "msg_main_2",
        startedAt: at("01:00"),
        endedAt: at("01:03"),
        isError: false,
        spawnedAgentId: null,
      },
    ],
    userLines: 4,
    startedAt: at("00:00"),
    endedAt: at("02:35"),
  },
  subagents: [
    {
      agentId: "demoagent03",
      agentType: null,
      model: null,
      spawnDepth: null,
      isBuiltIn: null,
      finished: null,
      parentToolUseId: null,
      parentAgentId: null,
      replies: [
        {
          messageId: "msg_orphan_1",
          model: null,
          effort: null,
          firstAt: at("00:01"),
          lastAt: at("00:01"),
          usage: usage(0, 3),
          toolUseIds: ["toolu_orphan_glob"],
          lineCount: 1,
        },
      ],
      toolCalls: [
        {
          toolUseId: "toolu_orphan_glob",
          name: "Glob",
          mcpServer: null,
          kind: "read",
          messageId: "msg_orphan_1",
          startedAt: at("00:01"),
          endedAt: null,
          isError: null,
          spawnedAgentId: null,
        },
      ],
      userLines: 0,
      startedAt: at("00:01"),
      endedAt: at("00:01"),
    },
    {
      agentId: "demoagent01",
      agentType: "code-reviewer",
      model: "claude-sonnet-5",
      spawnDepth: 1,
      isBuiltIn: false,
      finished: true,
      parentToolUseId: "toolu_main_agent",
      parentAgentId: "main",
      replies: [
        {
          messageId: "msg_rev_1",
          model: "claude-sonnet-5",
          effort: "medium",
          firstAt: at("00:12"),
          lastAt: at("00:12"),
          usage: usage(4, 12, 50),
          toolUseIds: ["toolu_rev_grep", "toolu_rev_task"],
          lineCount: 1,
        },
        {
          messageId: "msg_rev_2",
          model: "claude-sonnet-5",
          effort: null,
          firstAt: at("02:20"),
          lastAt: at("02:20"),
          usage: usage(0, 6),
          toolUseIds: ["toolu_rev_handback"],
          lineCount: 1,
        },
      ],
      toolCalls: [
        {
          toolUseId: "toolu_rev_grep",
          name: "Grep",
          mcpServer: null,
          kind: "read",
          messageId: "msg_rev_1",
          startedAt: at("00:12"),
          endedAt: at("00:13"),
          isError: false,
          spawnedAgentId: null,
        },
        {
          toolUseId: "toolu_rev_task",
          name: "Task",
          mcpServer: null,
          kind: "agent",
          messageId: "msg_rev_1",
          startedAt: at("00:12"),
          endedAt: at("02:00"),
          isError: false,
          spawnedAgentId: "demoagent02",
        },
        {
          toolUseId: "toolu_rev_handback",
          name: "SubagentHandback",
          mcpServer: null,
          kind: "agent",
          messageId: "msg_rev_2",
          startedAt: at("02:20"),
          endedAt: null,
          isError: null,
          spawnedAgentId: null,
        },
      ],
      userLines: 3,
      startedAt: at("00:10"),
      endedAt: at("02:20"),
    },
    {
      agentId: "demoagent02",
      agentType: "test-writer",
      model: "claude-haiku-5",
      spawnDepth: 2,
      isBuiltIn: null,
      finished: null,
      parentToolUseId: "toolu_rev_task",
      parentAgentId: "demoagent01",
      replies: [
        {
          messageId: "msg_nested_1",
          model: "claude-haiku-5",
          effort: "low",
          firstAt: at("00:20"),
          lastAt: at("00:20"),
          usage: usage(1, 2),
          toolUseIds: ["toolu_nested_edit", "toolu_nested_write"],
          lineCount: 1,
        },
      ],
      toolCalls: [
        {
          toolUseId: "toolu_nested_edit",
          name: "Edit",
          mcpServer: null,
          kind: "edit",
          messageId: "msg_nested_1",
          startedAt: at("00:20"),
          endedAt: at("00:25"),
          isError: false,
          spawnedAgentId: null,
        },
        {
          toolUseId: "toolu_nested_write",
          name: "Write",
          mcpServer: null,
          kind: "edit",
          messageId: "msg_nested_1",
          startedAt: at("00:20"),
          endedAt: at("00:25"),
          isError: false,
          spawnedAgentId: null,
        },
      ],
      userLines: 1,
      startedAt: at("00:20"),
      endedAt: at("00:25"),
    },
  ],
  versionsSeen: ["9.9.1", "9.9.2"],
  lines: {
    // Main: 14 non-blank lines. Reviewer: 5. Nested: 2. Orphan: 2.
    total: 23,
    unknownByType: { "": 1, "internal-trace-demo": 1, "mystery-line": 1 },
    malformed: 2,
  },
};

describe("parseSession golden output", () => {
  it("parses the synthetic session into the expected structure", async () => {
    expect(await parseSession(makeInput())).toStrictEqual(EXPECTED);
  });

  it("gives identical output when the same input is parsed again", async () => {
    const first = await parseSession(makeInput());
    const second = await parseSession(makeInput());
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps no user content: no text, inputs, outputs, paths, branch or description", async () => {
    const serialised = JSON.stringify(await parseSession(makeInput()));
    expect(serialised).not.toContain(CONTENT_MARKER);
    expect(serialised).not.toContain("workspace");
  });
});
