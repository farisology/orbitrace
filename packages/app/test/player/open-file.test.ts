// The player's file opening: file type, then size limit, then the app's loader. Replay files
// only: a transcript is refused (decided on #19). Every value is invented.

import { describe, expect, it, vi } from "vitest";
import { FILE_MESSAGES } from "../../src/load-file";
import { EXPORT_COMMAND, PLAYER_MESSAGES } from "../../src/player/messages";
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_SIZE_TEXT,
  fileLabel,
  fileTypeProblem,
  formatMegabytes,
  openPlayerFile,
  sizeProblem,
} from "../../src/player/open-file";

/** A synthetic transcript line with invented values. */
const TRANSCRIPT_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-01-01T00:00:00.000Z",
  sessionId: "synthetic-session",
  message: { role: "user", content: "invented prompt" },
});
import { makeModel } from "../helpers";

describe("size limit", () => {
  it("is 50 MB", () => {
    expect(MAX_REPLAY_BYTES).toBe(52_428_800);
    expect(MAX_REPLAY_SIZE_TEXT).toBe("50 MB");
  });

  it("formats whole and fractional megabytes", () => {
    expect(formatMegabytes(1024 * 1024)).toBe("1 MB");
    expect(formatMegabytes(75.9 * 1024 * 1024)).toBe("75.9 MB");
    expect(formatMegabytes(512 * 1024)).toBe("0.5 MB");
  });

  it("accepts a size up to the limit and refuses one over it, saying both sizes", () => {
    expect(sizeProblem(MAX_REPLAY_BYTES)).toBeNull();
    const problem = sizeProblem(MAX_REPLAY_BYTES + 1);
    expect(problem?.title).toBe(
      "This file is 50.0 MB, larger than the 50 MB limit, so it was not opened.",
    );
    expect(problem?.problems).toEqual([]);
    expect(sizeProblem(3 * 1024 * 1024, 2 * 1024 * 1024)?.title).toContain("2 MB limit");
  });
});

describe("openPlayerFile", () => {
  it("refuses a file over the limit before reading any of it", async () => {
    const text = vi.fn(async () => JSON.stringify(makeModel()));
    const result = await openPlayerFile({
      name: "big.replay.json",
      size: MAX_REPLAY_BYTES + 1,
      text,
    });
    expect(result.ok).toBe(false);
    expect(text).not.toHaveBeenCalled();
  });

  it("opens a valid replay within the limit", async () => {
    const json = JSON.stringify(makeModel());
    const file = new File([json], "example.replay.json", { type: "application/json" });
    const result = await openPlayerFile(file);
    expect(result).toMatchObject({ ok: true, kind: "replay" });
  });

  it("uses a smaller limit when given one", async () => {
    const file = new File([JSON.stringify(makeModel())], "example.replay.json");
    const result = await openPlayerFile(file, 16);
    expect(result).toMatchObject({ ok: false, error: { title: expect.stringContaining("limit") } });
  });

  it("refuses a file that fails the schema, with the readable problem list", async () => {
    const file = new File(
      [JSON.stringify({ formatVersion: 1, agents: "none" })],
      "bad.replay.json",
    );
    const result = await openPlayerFile(file);
    expect(result).toMatchObject({
      ok: false,
      error: {
        title: FILE_MESSAGES.invalidReplay,
        problems: expect.arrayContaining([expect.any(String)]),
      },
    });
  });

  it("refuses a file type it does not read, without offering transcripts", async () => {
    const result = await openPlayerFile(new File(["x"], "notes.txt"));
    expect(result).toEqual({
      ok: false,
      error: { title: PLAYER_MESSAGES.unsupported, problems: [] },
    });
    expect(PLAYER_MESSAGES.unsupported).not.toMatch(/jsonl|transcript/i);
  });

  it("refuses a .jsonl transcript before reading any of it, and says to export a replay", async () => {
    const file = new File([`${TRANSCRIPT_LINE}\n`], "example-session.jsonl");
    const text = vi.spyOn(file, "text");
    const result = await openPlayerFile(file);
    expect(result).toEqual({
      ok: false,
      error: {
        title: PLAYER_MESSAGES.transcriptRefused,
        problems: [PLAYER_MESSAGES.transcriptRefusedHelp],
      },
    });
    expect(text).not.toHaveBeenCalled();
    expect(PLAYER_MESSAGES.transcriptRefusedHelp).toContain(EXPORT_COMMAND);
    // Fixed text: nothing from the file, not even its name.
    expect(JSON.stringify(result)).not.toContain("example-session");
  });

  it("says a transcript is refused even when it is also over the size limit", async () => {
    const file = { name: "large.JSONL", size: MAX_REPLAY_BYTES + 1, text: vi.fn(async () => "") };
    const result = await openPlayerFile(file);
    expect(result).toMatchObject({
      ok: false,
      error: { title: PLAYER_MESSAGES.transcriptRefused },
    });
    expect(file.text).not.toHaveBeenCalled();
  });
});

describe("fileTypeProblem", () => {
  it("accepts .json and .replay.json in any case", () => {
    expect(fileTypeProblem("example.replay.json")).toBeNull();
    expect(fileTypeProblem("EXAMPLE.JSON")).toBeNull();
  });

  it("refuses a transcript and any other type with different messages", () => {
    expect(fileTypeProblem("example.jsonl")?.title).toBe(PLAYER_MESSAGES.transcriptRefused);
    expect(fileTypeProblem("example.txt")?.title).toBe(PLAYER_MESSAGES.unsupported);
    expect(fileTypeProblem("example")?.title).toBe(PLAYER_MESSAGES.unsupported);
  });

  it("is stricter than the local app's loader, which still takes transcripts", () => {
    expect(FILE_MESSAGES.unsupported).toContain(".jsonl transcript");
  });
});

describe("fileLabel", () => {
  it("names a replay file", () => {
    expect(fileLabel("example.replay.json")).toBe("Replay file: example.replay.json");
  });
});
