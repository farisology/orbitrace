import { describe, expect, it } from "vitest";
import {
  FILE_MESSAGES,
  droppedKind,
  loadFile,
  loadFileText,
  replayFromJson,
  replayFromTranscript,
  replayFromValue,
} from "../src/load-file";
import { DEMO, makeModel } from "./helpers";

// A hand-written synthetic transcript: one prompt, one reply with two tool calls (one fails),
// the results, and a closing reply. Every id and value is invented.
const base = { sessionId: "synthetic-session", version: "2.1.300", isSidechain: false };
const lines = [
  {
    ...base,
    type: "user",
    timestamp: "2026-01-01T10:00:00.000Z",
    message: { role: "user", content: "Synthetic prompt." },
  },
  {
    ...base,
    type: "assistant",
    timestamp: "2026-01-01T10:00:02.000Z",
    effort: "high",
    message: {
      id: "msg_synthetic_1",
      model: "claude-opus-5-5",
      role: "assistant",
      usage: {
        input_tokens: 12,
        output_tokens: 80,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 20,
      },
      content: [
        {
          type: "tool_use",
          id: "toolu_synthetic_1",
          name: "Read",
          input: { file_path: "src/widget.ts" },
        },
        {
          type: "tool_use",
          id: "toolu_synthetic_2",
          name: "Bash",
          input: { command: "echo synthetic" },
        },
      ],
    },
  },
  {
    ...base,
    type: "user",
    timestamp: "2026-01-01T10:00:03.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_synthetic_1", content: "synthetic" }],
    },
  },
  {
    ...base,
    type: "user",
    timestamp: "2026-01-01T10:00:05.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_synthetic_2",
          is_error: true,
          content: "synthetic",
        },
      ],
    },
  },
  {
    ...base,
    type: "assistant",
    timestamp: "2026-01-01T10:00:07.000Z",
    message: {
      id: "msg_synthetic_2",
      model: "claude-opus-5-5",
      role: "assistant",
      usage: {
        input_tokens: 4,
        output_tokens: 30,
        cache_read_input_tokens: 480,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: "Synthetic reply." }],
    },
  },
];
const TRANSCRIPT = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

describe("droppedKind", () => {
  it("tells replays and transcripts apart by extension", () => {
    expect(droppedKind("demo.replay.json")).toBe("replay");
    expect(droppedKind("SESSION.JSON")).toBe("replay");
    expect(droppedKind("session.jsonl")).toBe("transcript");
    expect(droppedKind("notes.txt")).toBeNull();
  });
});

describe("replay files", () => {
  it("accepts a valid replay", () => {
    const result = replayFromJson(JSON.stringify(DEMO));
    expect(result).toEqual({ ok: true, kind: "replay", model: DEMO });
  });

  it("rejects text that is not JSON", () => {
    expect(replayFromJson("{not json")).toEqual({
      ok: false,
      error: { title: FILE_MESSAGES.notJson, problems: [] },
    });
  });

  it("rejects an invalid replay with the reasons, never quoting a value", () => {
    const bad = { ...makeModel(), formatVersion: 2, secretField: "synthetic-private-value" };
    const result = replayFromValue(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBe(FILE_MESSAGES.invalidReplay);
    expect(result.error.problems.length).toBeGreaterThan(0);
    expect(result.error.problems.join("\n")).not.toContain("synthetic-private-value");
  });
});

describe("transcript files", () => {
  it("parses and builds a replay in the page", async () => {
    const result = await replayFromTranscript(TRANSCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("transcript");
    const [main] = result.model.agents;
    expect(result.model.agents).toHaveLength(1);
    expect(main.family).toBe("opus");
    expect(main.effort).toBe("high");
    expect(main.tools.map((t) => [t.name, t.kind, t.failed])).toEqual([
      ["Read", "read", false],
      ["Bash", "shell", true],
    ]);
    const json = JSON.stringify(result.model);
    for (const content of [
      "Synthetic reply",
      "Synthetic prompt",
      "src/widget.ts",
      "echo synthetic",
      "synthetic-session",
    ]) {
      expect(json).not.toContain(content);
    }
  });

  it("rejects an empty transcript", async () => {
    expect(await replayFromTranscript("\n\n")).toEqual({
      ok: false,
      error: { title: FILE_MESSAGES.emptyTranscript, problems: [] },
    });
  });

  it("rejects lines with no timestamps and counts the malformed ones", async () => {
    const result = await replayFromTranscript('not json\n{"type":"user"}\n');
    expect(result).toEqual({
      ok: false,
      error: {
        title: FILE_MESSAGES.noTimedLines,
        problems: ["1 of 2 lines were not JSON objects."],
      },
    });
    const clean = await replayFromTranscript('{"type":"mode"}\n');
    expect(clean).toEqual({
      ok: false,
      error: { title: FILE_MESSAGES.noTimedLines, problems: [] },
    });
  });
});

describe("loadFileText and loadFile", () => {
  it("routes by extension", async () => {
    expect((await loadFileText("a.replay.json", JSON.stringify(DEMO))).ok).toBe(true);
    expect((await loadFileText("a.jsonl", TRANSCRIPT)).ok).toBe(true);
    expect(await loadFileText("a.txt", "")).toEqual({
      ok: false,
      error: { title: FILE_MESSAGES.unsupported, problems: [] },
    });
  });

  it("reads a File and refuses unsupported names without reading", async () => {
    const ok = await loadFile(new File([TRANSCRIPT], "session.jsonl"));
    expect(ok.ok).toBe(true);
    let read = false;
    const unsupported = await loadFile({
      name: "picture.png",
      text: async () => {
        read = true;
        return "";
      },
    });
    expect(unsupported.ok).toBe(false);
    expect(read).toBe(false);
  });

  it("reports a file that cannot be read", async () => {
    const result = await loadFile({
      name: "a.replay.json",
      text: () => Promise.reject(new Error("synthetic read failure")),
    });
    expect(result).toEqual({ ok: false, error: { title: FILE_MESSAGES.unreadable, problems: [] } });
  });
});
