// Where the history store lives and the checks on that place (#25). Path rules run on every
// Node; nothing here creates a store.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkHistoryLocation } from "../../src/history/location.js";
import {
  HISTORY_DATA_DIR_ENV,
  resolveHistoryLocation,
  type HistoryLocation,
} from "../../src/sources/node.js";
import { useSandbox } from "./helpers.js";

const sandbox = useSandbox();

describe("resolveHistoryLocation", () => {
  it("uses ORBITRACE_DATA_DIR when set", () => {
    const box = sandbox();
    expect(process.env[HISTORY_DATA_DIR_ENV]).toBe(box.data);
    expect(resolveHistoryLocation()).toEqual({
      dir: box.data,
      dbFile: join(box.data, "history.sqlite"),
      lockFile: join(box.data, "history.lock"),
    });
  });

  it("falls back to .orbitrace in the home folder", () => {
    const box = sandbox();
    delete process.env[HISTORY_DATA_DIR_ENV];
    expect(resolveHistoryLocation().dir).toBe(join(box.home, ".orbitrace"));
    expect(
      resolveHistoryLocation({ env: {}, homeDir: "/srv/example-home", platform: "linux" }).dir,
    ).toBe("/srv/example-home/.orbitrace");
    expect(
      resolveHistoryLocation({ env: {}, homeDir: "D:\\Profiles\\example", platform: "win32" }).dir,
    ).toBe("D:\\Profiles\\example\\.orbitrace");
  });

  it("prefers an explicit folder, and refuses a relative one", () => {
    expect(resolveHistoryLocation({ dataDir: "/srv/history", env: {} }).dir).toBe("/srv/history");
    expect(() =>
      resolveHistoryLocation({ env: { [HISTORY_DATA_DIR_ENV]: "relative/dir" } }),
    ).toThrow(expect.objectContaining({ code: "unsafe-location" }));
  });

  it("refuses when there is no home folder and no setting", () => {
    expect(() => resolveHistoryLocation({ env: {}, homeDir: "", platform: "linux" })).toThrow(
      expect.objectContaining({ code: "unsafe-location" }),
    );
  });
});

describe("checkHistoryLocation", () => {
  const at = (dir: string): HistoryLocation => ({
    dir,
    dbFile: join(dir, "history.sqlite"),
    lockFile: join(dir, "history.lock"),
  });

  it("accepts the sandbox data folder", () => {
    expect(() => checkHistoryLocation(at(sandbox().data))).not.toThrow();
  });

  it("refuses a folder inside CLAUDE_CONFIG_DIR or the default config folder", () => {
    const box = sandbox();
    expect(() => checkHistoryLocation(at(join(box.config, "history")))).toThrow(
      expect.objectContaining({ code: "unsafe-location" }),
    );
    expect(() => checkHistoryLocation(at(join(box.home, ".claude", "x")))).toThrow(
      expect.objectContaining({ code: "unsafe-location" }),
    );
    expect(() =>
      checkHistoryLocation(at("D:\\Profiles\\example\\.Claude\\h"), {
        platform: "win32",
        homeDir: "D:\\Profiles\\example",
        env: {},
      }),
    ).toThrow(expect.objectContaining({ code: "unsafe-location" }));
  });

  it("refuses a folder inside a git working tree", async () => {
    const box = sandbox();
    const repo = join(box.base, "example-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    expect(() => checkHistoryLocation(at(join(repo, "nested", "history")))).toThrow(
      expect.objectContaining({
        code: "unsafe-location",
        message: expect.stringContaining("git") as unknown as string,
      }),
    );
  });

  it("never names the path in its message", () => {
    const box = sandbox();
    expect(() => checkHistoryLocation(at(join(box.config, "history")))).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(box.base) as unknown as string,
      }),
    );
  });
});
