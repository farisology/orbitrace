// Where the history store lives and the checks on that place (#25). Path rules run on every
// Node; nothing here creates a store.
import { mkdir } from "node:fs/promises";
import { join, normalize, win32 } from "node:path";
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
    // The platform is named: with none, this host's path rules apply, and on Windows
    // "/srv/history" normalises to "\srv\history" (#204).
    const env = { [HISTORY_DATA_DIR_ENV]: "/srv/ignored" };
    expect(resolveHistoryLocation({ dataDir: "/srv/history", env, platform: "linux" })).toEqual({
      dir: "/srv/history",
      dbFile: "/srv/history/history.sqlite",
      lockFile: "/srv/history/history.lock",
    });
    expect(resolveHistoryLocation({ dataDir: "/srv/history", env: {} }).dir).toBe(
      normalize("/srv/history"),
    );
    expect(() =>
      resolveHistoryLocation({ env: { [HISTORY_DATA_DIR_ENV]: "relative/dir" } }),
    ).toThrow(expect.objectContaining({ code: "unsafe-location" }));
  });

  it("follows Windows path rules on any host when the platform is win32", () => {
    const win = (dataDir: string) =>
      resolveHistoryLocation({ dataDir, env: {}, platform: "win32" }).dir;
    expect(win("D:/Data/history")).toBe("D:\\Data\\history");
    expect(win("\\\\server\\share\\history")).toBe("\\\\server\\share\\history");
    // Rooted on the current drive: Node's path.win32 counts it as absolute.
    expect(win("/srv/history")).toBe("\\srv\\history");
    expect(resolveHistoryLocation({ dataDir: "D:\\Data\\h", env: {}, platform: "win32" })).toEqual({
      dir: "D:\\Data\\h",
      dbFile: "D:\\Data\\h\\history.sqlite",
      lockFile: "D:\\Data\\h\\history.lock",
    });
    // Windows looks environment variables up case-insensitively; other systems do not.
    expect(
      resolveHistoryLocation({ env: { orbitrace_data_dir: "D:\\Data\\h" }, platform: "win32" }).dir,
    ).toBe("D:\\Data\\h");
    expect(
      resolveHistoryLocation({
        env: { orbitrace_data_dir: "/srv/ignored" },
        homeDir: "/srv/example-home",
        platform: "linux",
      }).dir,
    ).toBe("/srv/example-home/.orbitrace");
    // Relative and drive-relative paths are refused.
    for (const dataDir of ["relative\\dir", "D:relative", "D:"]) {
      expect(() => win(dataDir)).toThrow(expect.objectContaining({ code: "unsafe-location" }));
    }
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

  it("follows Windows path rules on any host when the platform is win32", () => {
    const options = {
      platform: "win32",
      homeDir: "D:\\Profiles\\example",
      env: { claude_config_dir: "E:\\Config\\example" },
    };
    const winAt = (dir: string): HistoryLocation => ({
      dir,
      dbFile: win32.join(dir, "history.sqlite"),
      lockFile: win32.join(dir, "history.lock"),
    });
    // CLAUDE_CONFIG_DIR is found whatever its case, and folders compare case-insensitively.
    for (const dir of [
      "E:\\Config\\example\\h",
      "e:/config/EXAMPLE/h",
      "D:\\PROFILES\\example\\.claude",
    ]) {
      expect(() => checkHistoryLocation(winAt(dir), options)).toThrow(
        expect.objectContaining({ code: "unsafe-location" }),
      );
    }
    // Beside the config folders, or on another drive, is allowed. (No share path here: on a
    // Windows host the check looks for .git on disk, and a share would be a network lookup.)
    for (const dir of [
      "D:\\Profiles\\example\\.orbitrace",
      "E:\\Config\\example-other",
      "F:\\history",
    ]) {
      expect(() => checkHistoryLocation(winAt(dir), options)).not.toThrow();
    }
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
