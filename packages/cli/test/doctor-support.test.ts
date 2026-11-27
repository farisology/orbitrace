/** The helpers behind `orbitrace doctor`: the engines range check and path display. */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseVersion, satisfiesRange } from "../src/doctor/engines.js";
import {
  folderState,
  homeMarker,
  readAccessFix,
  rootPathShower,
  setEnvCommand,
  shellPath,
  showPath,
  unsetEnvCommand,
} from "../src/doctor/paths.js";
import type { SourceRoot } from "@orbitrace/core";
import { CLAUDE_CODE_RUNTIME } from "@orbitrace/core/node";
import type { HostContext } from "../src/sessions.js";
import { cannotTestPermissions } from "./doctor-helpers.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe.skipIf(process.platform === "win32")("rootPathShower", () => {
  const host: HostContext = {
    platform: "linux",
    homeDir: "/srv/example-home",
    env: {},
    cwd: "/work/cwd-marker-zq/repo",
  };
  const userRoot = (root: string): SourceRoot => ({
    runtime: CLAUDE_CODE_RUNTIME,
    root,
    resolvedBy: "user-setting",
    available: true,
  });

  it("shows a folder from a relative --config-dir relative to the working folder", () => {
    const show = rootPathShower(host, [userRoot("/work/cwd-marker-zq/repo/cfg")], ["./cfg"]);
    expect(show("/work/cwd-marker-zq/repo/cfg")).toBe("./cfg");
    expect(show("/work/cwd-marker-zq/repo/cfg/sessions")).toBe("./cfg/sessions");
  });

  it("keeps a value that leaves the working folder relative, and the working folder itself as .", () => {
    const up = rootPathShower(host, [userRoot("/work/cwd-marker-zq/cfg")], ["../cfg"]);
    expect(up("/work/cwd-marker-zq/cfg")).toBe("../cfg");
    const here = rootPathShower(host, [userRoot("/work/cwd-marker-zq/repo")], ["."]);
    expect(here("/work/cwd-marker-zq/repo/sessions")).toBe("./sessions");
  });

  it("matches the parent core uses when the value names the projects folder", () => {
    const show = rootPathShower(host, [userRoot("/work/cwd-marker-zq/repo/cfg")], ["cfg/projects"]);
    expect(show("/work/cwd-marker-zq/repo/cfg")).toBe("./cfg");
  });

  it("uses showPath for absolute and ~ values and for folders found another way", () => {
    const roots: SourceRoot[] = [
      userRoot("/srv/sessions-example"),
      userRoot("/srv/example-home/typed"),
      { ...userRoot("/srv/example-home/.claude"), resolvedBy: "os-default" },
      { ...userRoot("/work/cwd-marker-zq/repo/env"), resolvedBy: "environment" },
    ];
    const show = rootPathShower(host, roots, ["/srv/sessions-example", "~/typed"]);
    expect(show("/srv/sessions-example")).toBe("/srv/sessions-example");
    expect(show("/srv/example-home/typed/sessions")).toBe("~/typed/sessions");
    expect(show("/srv/example-home/.claude")).toBe("~/.claude");
    // Not from a relative --config-dir: shown as CLAUDE_CONFIG_DIR has it.
    expect(show("/work/cwd-marker-zq/repo/env")).toBe("/work/cwd-marker-zq/repo/env");
  });

  it("does not treat a folder that only shares a name prefix as inside the root", () => {
    const show = rootPathShower(host, [userRoot("/work/cwd-marker-zq/repo/cfg")], ["cfg"]);
    expect(show("/work/cwd-marker-zq/repo/cfg-other")).toBe("/work/cwd-marker-zq/repo/cfg-other");
  });
});

describe("parseVersion", () => {
  it("reads major.minor.patch, with or without a leading v", () => {
    expect(parseVersion("22.13.0")).toEqual([22, 13, 0]);
    expect(parseVersion("v20.19.1")).toEqual([20, 19, 1]);
  });

  it("rejects anything else", () => {
    for (const value of ["", "22", "22.13", "22.13.0-pre", "x.y.z"]) {
      expect(parseVersion(value)).toBeNull();
    }
  });
});

describe("satisfiesRange", () => {
  it("checks the ranges this repository uses", () => {
    expect(satisfiesRange("20.0.0", ">=20")).toBe(true);
    expect(satisfiesRange("19.8.1", ">=20")).toBe(false);
    const root = "^20.19.0 || ^22.13.0 || >=24";
    expect(satisfiesRange("20.19.0", root)).toBe(true);
    expect(satisfiesRange("20.18.9", root)).toBe(false);
    expect(satisfiesRange("21.0.0", root)).toBe(false);
    expect(satisfiesRange("22.12.0", root)).toBe(false);
    expect(satisfiesRange("22.13.0", root)).toBe(true);
    expect(satisfiesRange("23.1.0", root)).toBe(false);
    expect(satisfiesRange("26.5.0", root)).toBe(true);
  });

  it("understands each comparator", () => {
    expect(satisfiesRange("20.5.0", "20")).toBe(true);
    expect(satisfiesRange("21.0.0", "20")).toBe(false);
    expect(satisfiesRange("20.1.9", "20.1")).toBe(true);
    expect(satisfiesRange("20.2.0", "20.1")).toBe(false);
    expect(satisfiesRange("20.1.2", "=20.1.2")).toBe(true);
    expect(satisfiesRange("20.1.3", "20.1.2")).toBe(false);
    expect(satisfiesRange("21.0.0", ">20")).toBe(true);
    expect(satisfiesRange("20.9.9", ">20")).toBe(false);
    expect(satisfiesRange("20.0.1", ">20.0.0")).toBe(true);
    expect(satisfiesRange("20.9.9", "<=20")).toBe(true);
    expect(satisfiesRange("21.0.0", "<=20")).toBe(false);
    expect(satisfiesRange("20.0.0", "<=20.0.0")).toBe(true);
    expect(satisfiesRange("19.9.9", "<20")).toBe(true);
    expect(satisfiesRange("20.0.0", "<20")).toBe(false);
    expect(satisfiesRange("20.3.9", "~20.3.1")).toBe(true);
    expect(satisfiesRange("20.4.0", "~20.3.1")).toBe(false);
    expect(satisfiesRange("20.9.0", "~20")).toBe(true);
    expect(satisfiesRange("0.2.5", "^0.2.3")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
    expect(satisfiesRange("1.2.3", "*")).toBe(true);
    expect(satisfiesRange("1.2.3", "1.x")).toBe(true);
    expect(satisfiesRange("20.19.0", ">=20.19.0 <21")).toBe(true);
    expect(satisfiesRange("21.0.0", ">=20.19.0 <21")).toBe(false);
    expect(satisfiesRange("20.0.0", ">= 20")).toBe(true);
  });

  it("returns null for a version or a range it does not understand", () => {
    expect(satisfiesRange("22", ">=20")).toBeNull();
    expect(satisfiesRange("22.0.0", "")).toBeNull();
    expect(satisfiesRange("22.0.0", "20.0.0 - 22.0.0")).toBeNull();
    expect(satisfiesRange("22.0.0", ">=20 ||")).toBeNull();
    expect(satisfiesRange("22.0.0", "latest")).toBeNull();
    expect(satisfiesRange("22.0.0", ">*")).toBeNull();
  });
});

describe("showPath and homeMarker", () => {
  it("shows the home folder as ~ on macOS and Linux", () => {
    expect(homeMarker("linux")).toBe("~");
    expect(showPath("/srv/example-home/.claude", "/srv/example-home", "linux")).toBe("~/.claude");
    expect(showPath("/srv/example-home", "/srv/example-home/", "linux")).toBe("~");
    expect(showPath("/srv/example-home-other/x", "/srv/example-home", "linux")).toBe(
      "/srv/example-home-other/x",
    );
    expect(showPath("/opt/config", "/srv/example-home", "darwin")).toBe("/opt/config");
    expect(showPath("/opt/config", "", "linux")).toBe("/opt/config");
  });

  it("shows the home folder as %USERPROFILE% on Windows, case-insensitively", () => {
    expect(homeMarker("win32")).toBe("%USERPROFILE%");
    expect(showPath("c:\\profiles\\example\\.claude", "C:\\Profiles\\Example", "win32")).toBe(
      "%USERPROFILE%\\.claude",
    );
    expect(showPath("D:\\config", "C:\\Profiles\\Example", "win32")).toBe("D:\\config");
  });
});

describe("shellPath", () => {
  it("quotes only what needs quoting and keeps ~/ outside the quotes", () => {
    expect(shellPath("~", "linux")).toBe("~");
    expect(shellPath("~/.claude", "linux")).toBe("~/.claude");
    expect(shellPath("~/my config", "linux")).toBe("~/'my config'");
    expect(shellPath("/opt/it's here", "darwin")).toBe(`'/opt/it'\\''s here'`);
    expect(shellPath("/opt/config", "linux")).toBe("/opt/config");
    expect(shellPath("%USERPROFILE%\\.claude", "win32")).toBe('"%USERPROFILE%\\.claude"');
  });
});

describe("fix commands", () => {
  it("names the right command for each platform", () => {
    expect(readAccessFix("~/.claude", "linux")).toBe("chmod -R u+rX ~/.claude");
    expect(readAccessFix("%USERPROFILE%\\.claude", "win32")).toContain('icacls "%USERPROFILE%');
    expect(setEnvCommand("CLAUDE_CONFIG_DIR", "/x", "darwin")).toBe("export CLAUDE_CONFIG_DIR=/x");
    expect(setEnvCommand("CLAUDE_CONFIG_DIR", "C:\\x", "win32")).toBe(
      "set CLAUDE_CONFIG_DIR=C:\\x",
    );
    expect(unsetEnvCommand("CLAUDE_CONFIG_DIR", "linux")).toBe("unset CLAUDE_CONFIG_DIR");
    expect(unsetEnvCommand("CLAUDE_CONFIG_DIR", "win32")).toBe("set CLAUDE_CONFIG_DIR=");
  });
});

describe("folderState", () => {
  it("tells a folder, a missing path and a file apart", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "x");
    expect(await folderState(dir)).toBe("ok");
    expect(await folderState(join(dir, "missing"))).toBe("missing");
    expect(await folderState(join(dir, "file.txt"))).toBe("not-a-folder");
    expect(await folderState(join(dir, "file.txt", "below"))).toBe("not-a-folder");
  });

  it.skipIf(cannotTestPermissions())("reports a folder it cannot list as unreadable", async () => {
    const dir = join(makeTempDir(), "locked");
    mkdirSync(dir);
    chmodSync(dir, 0o000);
    try {
      expect(await folderState(dir)).toBe("unreadable");
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
