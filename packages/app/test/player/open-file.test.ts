// The player's file opening: size limit first, then the app's loader. Every value is invented.

import { describe, expect, it, vi } from "vitest";
import { FILE_MESSAGES } from "../../src/load-file";
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_SIZE_TEXT,
  fileLabel,
  formatMegabytes,
  openPlayerFile,
  sizeProblem,
} from "../../src/player/open-file";
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

  it("refuses a file type it does not read", async () => {
    const result = await openPlayerFile(new File(["x"], "notes.txt"));
    expect(result).toEqual({
      ok: false,
      error: { title: FILE_MESSAGES.unsupported, problems: [] },
    });
  });
});

describe("fileLabel", () => {
  it("names a replay file and a transcript", () => {
    expect(fileLabel("replay", "example.replay.json")).toBe("Replay file: example.replay.json");
    expect(fileLabel("transcript", "example.jsonl")).toBe(
      "Transcript: example.jsonl (main agent only)",
    );
  });
});
