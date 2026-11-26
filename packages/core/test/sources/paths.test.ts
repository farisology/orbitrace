// Path rules for macOS, Linux and Windows. Pure string tests: nothing here touches a disk.
// Every home folder, project and session name is invented.
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CONFIG_ENV,
  configRootFromTranscriptPath,
  defaultConfigRoot,
  desktopSessionBases,
  envValue,
  environmentConfigRoot,
  expandHome,
  homeFolder,
  normalizeRoot,
  pathApiFor,
  pathApiForPath,
  platformForPath,
  projectLabelFromCwd,
  projectLabelFromFolderName,
  rootIdentity,
  userConfigRoot,
} from "../../src/sources/node.js";

const MAC_HOME = "/Volumes/Data/example-home";
const LINUX_HOME = "/srv/example-home";
const WIN_HOME = "D:\\Profiles\\example-user";

describe("pathApiFor / pathApiForPath / platformForPath", () => {
  it("uses win32 rules only on Windows", () => {
    expect(pathApiFor("win32").sep).toBe("\\");
    expect(pathApiFor("darwin").sep).toBe("/");
    expect(pathApiFor("linux").sep).toBe("/");
    expect(pathApiFor("freebsd").sep).toBe("/");
  });

  it("detects Windows paths by drive letter or UNC prefix", () => {
    expect(platformForPath("D:\\Profiles\\x")).toBe("win32");
    expect(platformForPath("D:/Profiles/x")).toBe("win32");
    expect(platformForPath("\\\\server\\share\\x")).toBe("win32");
    expect(platformForPath("/srv/x")).toBe("posix");
    expect(pathApiForPath("D:\\x").sep).toBe("\\");
    expect(pathApiForPath("/srv/x").sep).toBe("/");
  });
});

describe("envValue", () => {
  it("is case-insensitive on Windows only", () => {
    const env = { claude_config_dir: "x" };
    expect(envValue(env, "CLAUDE_CONFIG_DIR", "win32")).toBe("x");
    expect(envValue(env, "CLAUDE_CONFIG_DIR", "linux")).toBeUndefined();
    expect(envValue({ CLAUDE_CONFIG_DIR: "y" }, "CLAUDE_CONFIG_DIR", "darwin")).toBe("y");
  });
});

describe("homeFolder", () => {
  it("prefers homeDir, then USERPROFILE on Windows or HOME elsewhere", () => {
    expect(homeFolder("darwin", MAC_HOME, { HOME: "/other" })).toBe(MAC_HOME);
    expect(homeFolder("linux", "", { HOME: LINUX_HOME })).toBe(LINUX_HOME);
    expect(homeFolder("win32", "", { USERPROFILE: WIN_HOME, HOME: "/ignored" })).toBe(WIN_HOME);
    expect(homeFolder("linux", "  ", {})).toBeUndefined();
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/ on every OS, and ~\\ on Windows", () => {
    expect(expandHome("~", MAC_HOME, "darwin")).toBe(MAC_HOME);
    expect(expandHome("~/cfg", LINUX_HOME, "linux")).toBe(`${LINUX_HOME}/cfg`);
    expect(expandHome("~\\cfg", WIN_HOME, "win32")).toBe(`${WIN_HOME}\\cfg`);
    expect(expandHome("~/cfg", WIN_HOME, "win32")).toBe(`${WIN_HOME}\\cfg`);
  });

  it("leaves other values alone", () => {
    expect(expandHome("~other/cfg", LINUX_HOME, "linux")).toBe("~other/cfg");
    expect(expandHome("~\\cfg", LINUX_HOME, "linux")).toBe("~\\cfg");
    expect(expandHome("~/cfg", undefined, "linux")).toBe("~/cfg");
    expect(expandHome("/abs", LINUX_HOME, "linux")).toBe("/abs");
  });
});

describe("normalizeRoot", () => {
  it("normalises posix paths and drops a trailing separator", () => {
    expect(normalizeRoot("/srv/a/../b/./c/", "linux")).toBe("/srv/b/c");
    expect(normalizeRoot("/", "darwin")).toBe("/");
  });

  it("normalises Windows paths, accepting forward slashes and UNC", () => {
    expect(normalizeRoot("D:/Profiles/example-user/.claude/", "win32")).toBe(
      `${WIN_HOME}\\.claude`,
    );
    expect(normalizeRoot("D:\\", "win32")).toBe("D:\\");
    expect(normalizeRoot("\\\\server\\share\\cfg\\", "win32")).toBe("\\\\server\\share\\cfg");
  });

  it("rejects relative, drive-relative and blank paths", () => {
    expect(normalizeRoot("relative/cfg", "linux")).toBeNull();
    expect(normalizeRoot("D:cfg", "win32")).toBeNull();
    expect(normalizeRoot("D:", "win32")).toBeNull();
    expect(normalizeRoot("   ", "darwin")).toBeNull();
  });
});

describe("rootIdentity", () => {
  it("folds case on Windows only", () => {
    expect(rootIdentity("D:\\Profiles\\X", "win32")).toBe("d:\\profiles\\x");
    expect(rootIdentity("/srv/X", "linux")).toBe("/srv/X");
    expect(rootIdentity("/Volumes/X", "darwin")).toBe("/Volumes/X");
  });
});

describe("defaultConfigRoot", () => {
  it("is <home>/.claude on macOS and Linux", () => {
    expect(defaultConfigRoot("darwin", MAC_HOME, {})).toBe(`${MAC_HOME}/.claude`);
    expect(defaultConfigRoot("linux", LINUX_HOME, {})).toBe(`${LINUX_HOME}/.claude`);
  });

  it("is <USERPROFILE>\\.claude on Windows", () => {
    expect(defaultConfigRoot("win32", WIN_HOME, {})).toBe(`${WIN_HOME}\\.claude`);
    expect(defaultConfigRoot("win32", "", { USERPROFILE: WIN_HOME })).toBe(`${WIN_HOME}\\.claude`);
  });

  it("is null without a home folder", () => {
    expect(defaultConfigRoot("linux", "", {})).toBeNull();
  });
});

describe("environmentConfigRoot", () => {
  it("reads CLAUDE_CONFIG_DIR and expands ~", () => {
    expect(
      environmentConfigRoot("linux", LINUX_HOME, { [CLAUDE_CONFIG_ENV]: "~/alt-config" }),
    ).toBe(`${LINUX_HOME}/alt-config`);
    expect(
      environmentConfigRoot("darwin", MAC_HOME, { [CLAUDE_CONFIG_ENV]: "/opt/example/cfg/" }),
    ).toBe("/opt/example/cfg");
    expect(environmentConfigRoot("win32", WIN_HOME, { claude_config_dir: "E:/example/cfg" })).toBe(
      "E:\\example\\cfg",
    );
  });

  it("is null when unset, blank or relative", () => {
    expect(environmentConfigRoot("linux", LINUX_HOME, {})).toBeNull();
    expect(environmentConfigRoot("linux", LINUX_HOME, { [CLAUDE_CONFIG_ENV]: "  " })).toBeNull();
    expect(environmentConfigRoot("linux", LINUX_HOME, { [CLAUDE_CONFIG_ENV]: "cfg" })).toBeNull();
  });
});

describe("userConfigRoot", () => {
  it("trims, expands ~ and normalises", () => {
    expect(userConfigRoot("  ~/my-cfg/ ", "darwin", MAC_HOME, {})).toBe(`${MAC_HOME}/my-cfg`);
    expect(userConfigRoot("~\\my-cfg", "win32", WIN_HOME, {})).toBe(`${WIN_HOME}\\my-cfg`);
    expect(userConfigRoot("not/absolute", "linux", LINUX_HOME, {})).toBeNull();
  });
});

describe("desktopSessionBases", () => {
  it("uses Application Support on macOS", () => {
    expect(desktopSessionBases("darwin", MAC_HOME, {})).toEqual([
      `${MAC_HOME}/Library/Application Support/Claude/local-agent-mode-sessions`,
    ]);
  });

  it("uses APPDATA on Windows, falling back to AppData\\Roaming", () => {
    expect(desktopSessionBases("win32", WIN_HOME, { APPDATA: "E:\\Roam" })).toEqual([
      "E:\\Roam\\Claude\\local-agent-mode-sessions",
    ]);
    expect(desktopSessionBases("win32", WIN_HOME, {})).toEqual([
      `${WIN_HOME}\\AppData\\Roaming\\Claude\\local-agent-mode-sessions`,
    ]);
  });

  it("uses XDG_CONFIG_HOME on Linux, falling back to ~/.config", () => {
    expect(desktopSessionBases("linux", LINUX_HOME, { XDG_CONFIG_HOME: "/srv/xdg" })).toEqual([
      "/srv/xdg/Claude/local-agent-mode-sessions",
    ]);
    expect(desktopSessionBases("linux", LINUX_HOME, {})).toEqual([
      `${LINUX_HOME}/.config/Claude/local-agent-mode-sessions`,
    ]);
  });

  it("is empty without a home folder or app data folder", () => {
    expect(desktopSessionBases("darwin", "", {})).toEqual([]);
    expect(desktopSessionBases("win32", "", {})).toEqual([]);
  });
});

describe("configRootFromTranscriptPath", () => {
  it("derives the root from a main transcript path", () => {
    expect(
      configRootFromTranscriptPath(
        "/srv/cfg/projects/-srv-example-project/session-a.jsonl",
        "linux",
      ),
    ).toBe("/srv/cfg");
    expect(
      configRootFromTranscriptPath(
        `${WIN_HOME}\\.claude\\projects\\D--example\\session-a.jsonl`,
        "win32",
      ),
    ).toBe(`${WIN_HOME}\\.claude`);
  });

  it("derives the root from a subagent transcript path", () => {
    expect(
      configRootFromTranscriptPath(
        `${MAC_HOME}/.claude/projects/-example/session-a/subagents/agent-a1.jsonl`,
        "darwin",
      ),
    ).toBe(`${MAC_HOME}/.claude`);
    expect(
      configRootFromTranscriptPath(
        "E:/cfg/projects/E--example/session-a/subagents/agent-a1.jsonl",
        "win32",
      ),
    ).toBe("E:\\cfg");
  });

  it("returns null for paths without the Claude Code shape", () => {
    expect(configRootFromTranscriptPath("/srv/cfg/other/x/session-a.jsonl", "linux")).toBeNull();
    expect(configRootFromTranscriptPath("/srv/cfg/projects/x/session-a.txt", "linux")).toBeNull();
    expect(configRootFromTranscriptPath("relative/projects/x/session-a.jsonl", "linux")).toBeNull();
    expect(
      configRootFromTranscriptPath("/srv/cfg/projects/x/session-a/subagents/other.jsonl", "linux"),
    ).toBeNull();
  });
});

describe("projectLabelFromCwd", () => {
  it("takes the last segment of posix and Windows paths on any host", () => {
    expect(projectLabelFromCwd("/srv/work/example-project")).toBe("example-project");
    expect(projectLabelFromCwd("/srv/work/example-project/")).toBe("example-project");
    expect(projectLabelFromCwd("E:\\work\\widget-app")).toBe("widget-app");
    expect(projectLabelFromCwd("E:\\")).toBe("E:");
    expect(projectLabelFromCwd("")).toBeNull();
    expect(projectLabelFromCwd("/")).toBeNull();
  });
});

describe("projectLabelFromFolderName", () => {
  it("takes the last dash-separated word of the encoded folder name", () => {
    expect(projectLabelFromFolderName("-srv-work-widget")).toBe("widget");
    expect(projectLabelFromFolderName("-srv-work-widget-")).toBe("widget");
    expect(projectLabelFromFolderName("---")).toBe("---");
  });
});
