// The recording switch shared by every host (#211, from the CLI's #195): the settings file in the
// data folder. Temporary folders only (useSandbox points HOME, CLAUDE_CONFIG_DIR and
// ORBITRACE_DATA_DIR at them before each test); runs on every Node, since no store is opened.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HISTORY_SETTINGS_FILE,
  HISTORY_SETTINGS_FORMAT,
  HistoryStoreError,
  historySettingsFile,
  readHistorySettings,
  resolveHistoryLocation,
  setHistoryRecording,
  writeHistorySettings,
} from "../../src/sources/node.js";
import { useSandbox } from "./helpers.js";

const sandbox = useSandbox();
const posix = process.platform !== "win32";

describe("the history settings file", () => {
  it("lives in the data folder", () => {
    const location = resolveHistoryLocation();
    expect(historySettingsFile(location)).toBe(join(sandbox().data, HISTORY_SETTINGS_FILE));
    expect(historySettingsFile(location, process.platform)).toBe(
      join(sandbox().data, HISTORY_SETTINGS_FILE),
    );
  });

  it("reads as off when missing, unreadable or of another shape", () => {
    const file = historySettingsFile(resolveHistoryLocation());
    expect(readHistorySettings(file)).toEqual({ state: "missing", recording: false });
    mkdirSync(sandbox().data, { recursive: true });
    for (const text of [
      "not json",
      "[]",
      JSON.stringify({ settings: 2, historyRecording: true }),
      JSON.stringify({ settings: HISTORY_SETTINGS_FORMAT, historyRecording: "yes" }),
    ]) {
      writeFileSync(file, text);
      expect(readHistorySettings(file)).toEqual({ state: "invalid", recording: false });
    }
    writeFileSync(file, JSON.stringify({ settings: 1, historyRecording: true }));
    expect(readHistorySettings(file)).toEqual({ state: "ok", recording: true });
  });

  it("writes the file through a rename, readable by the user only", () => {
    const location = resolveHistoryLocation();
    writeHistorySettings(location, { platform: process.platform }, true);
    const file = historySettingsFile(location);
    expect(readFileSync(file, "utf8")).toBe('{"settings":1,"historyRecording":true}\n');
    // No temporary file is left beside it.
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it.skipIf(!posix)("sets the file to 0600 and the folder to 0700 (not on Windows)", () => {
    const location = resolveHistoryLocation();
    setHistoryRecording(location, true);
    expect(statSync(historySettingsFile(location)).mode & 0o777).toBe(0o600);
    expect(statSync(location.dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a data folder inside a git working tree and creates nothing", () => {
    const repo = join(sandbox().base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    process.env["ORBITRACE_DATA_DIR"] = join(repo, "data");
    const location = resolveHistoryLocation();
    let caught: unknown;
    try {
      setHistoryRecording(location, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HistoryStoreError);
    expect((caught as HistoryStoreError).code).toBe("unsafe-location");
    expect((caught as Error).message).not.toContain(repo);
    expect(existsSync(location.dir)).toBe(false);
  });
});

describe("setHistoryRecording", () => {
  it("turning off with no file writes nothing and creates no folder", () => {
    const location = resolveHistoryLocation();
    expect(setHistoryRecording(location, false)).toEqual({
      before: { state: "missing", recording: false },
      recording: false,
      changed: false,
      written: false,
    });
    expect(existsSync(sandbox().data)).toBe(false);
  });

  it("turns on, says when it was already on, and turns off again by writing the file", () => {
    const location = resolveHistoryLocation();
    const file = historySettingsFile(location);
    expect(setHistoryRecording(location, true)).toMatchObject({
      recording: true,
      changed: true,
      written: true,
    });
    expect(readHistorySettings(file)).toEqual({ state: "ok", recording: true });
    expect(setHistoryRecording(location, true)).toMatchObject({ changed: false, written: true });
    expect(setHistoryRecording(location, false)).toEqual({
      before: { state: "ok", recording: true },
      recording: false,
      changed: true,
      written: true,
    });
    expect(readHistorySettings(file)).toEqual({ state: "ok", recording: false });
  });

  it("rewrites an unreadable file when turning off, so the file reads again", () => {
    const location = resolveHistoryLocation();
    const file = historySettingsFile(location);
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(file, "garbage");
    expect(setHistoryRecording(location, false)).toMatchObject({
      before: { state: "invalid", recording: false },
      changed: false,
      written: true,
    });
    expect(readHistorySettings(file)).toEqual({ state: "ok", recording: false });
  });
});
