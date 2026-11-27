import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  downloadCacheDir,
  EXTRA_ARGS_ENV,
  KEEP_ENV,
  MIN_NODE_MAJOR,
  missingBuildOutputs,
  nodeTooOld,
  packageDirFrom,
  processesMentioning,
  readSettings,
  suiteBundlePath,
  TEST_EDITOR_ARGUMENTS,
  testEditorArguments,
  TIMEOUT_ENV,
  VERSION_ENV,
} from "./run.js";
import type { SandboxDescription } from "./sandbox-description.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oti-test-")));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SANDBOX: SandboxDescription = {
  root: "/tmp/oti-abcdef",
  configDir: "/tmp/oti-abcdef/fx/config",
  homeDir: "/tmp/oti-abcdef/home",
  workspaceDir: "/tmp/oti-abcdef/ws",
  userDataDir: "/tmp/oti-abcdef/ud",
  extensionsDir: "/tmp/oti-abcdef/ext",
  workspaceSession: { key: "claude-code:test-1", projectLabel: "kite-workshop", transcript: "/x" },
  otherSessions: [],
};

describe("packageDirFrom, suiteBundlePath and downloadCacheDir", () => {
  it("find the package from the bundle folder and the suite bundle in it", () => {
    const pkg = join(tmpdir(), "pkg");
    expect(packageDirFrom(join(pkg, "test-integration", "dist"))).toBe(pkg);
    expect(suiteBundlePath(pkg)).toBe(join(pkg, "test-integration", "dist", "suite.cjs"));
  });

  it("keep the downloaded editor below node_modules, which every tool ignores", () => {
    const pkg = join(tmpdir(), "pkg");
    expect(downloadCacheDir(pkg)).toBe(join(pkg, "node_modules", ".cache", "vscode-test"));
  });
});

describe("missingBuildOutputs", () => {
  it("lists the extension, the app page and the suite bundle when absent", () => {
    const pkg = tempDir();
    expect(missingBuildOutputs(pkg)).toEqual([
      join("dist", "extension.js"),
      join("dist", "app", "index.html"),
      join("test-integration", "dist", "suite.cjs"),
    ]);
  });

  it("is empty once they exist", () => {
    const pkg = tempDir();
    for (const file of [
      ["dist", "extension.js"],
      ["dist", "app", "index.html"],
      ["test-integration", "dist", "suite.cjs"],
    ]) {
      mkdirSync(join(pkg, ...file.slice(0, -1)), { recursive: true });
      writeFileSync(join(pkg, ...file), "");
    }
    expect(missingBuildOutputs(pkg)).toEqual([]);
  });
});

describe("nodeTooOld", () => {
  it(`accepts Node.js ${MIN_NODE_MAJOR} and later and refuses older or unreadable versions`, () => {
    expect(nodeTooOld(`v${MIN_NODE_MAJOR}.0.0`)).toBe(false);
    expect(nodeTooOld("v26.5.0")).toBe(false);
    expect(nodeTooOld("v20.19.0")).toBe(true);
    expect(nodeTooOld("unknown")).toBe(true);
  });
});

describe("readSettings", () => {
  it("has defaults", () => {
    expect(readSettings({})).toEqual({
      version: "stable",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      keepSandbox: false,
      extraArguments: [],
    });
  });

  it("reads every setting", () => {
    expect(
      readSettings({
        [VERSION_ENV]: " 1.96.0 ",
        [TIMEOUT_ENV]: "5000",
        [KEEP_ENV]: "1",
        [EXTRA_ARGS_ENV]: "  --a  --b=1 ",
      }),
    ).toEqual({
      version: "1.96.0",
      timeoutMs: 5000,
      keepSandbox: true,
      extraArguments: ["--a", "--b=1"],
    });
  });

  it("falls back to the defaults for empty or invalid values", () => {
    const settings = readSettings({ [VERSION_ENV]: " ", [TIMEOUT_ENV]: "-3", [KEEP_ENV]: "yes" });
    expect(settings.version).toBe("stable");
    expect(settings.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(settings.keepSandbox).toBe(false);
    expect(readSettings({ [TIMEOUT_ENV]: "soon" }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("testEditorArguments", () => {
  it("adds the test runner's arguments, the suite and this package as the extension", () => {
    const pkg = join(tmpdir(), "pkg");
    const args = testEditorArguments(pkg, SANDBOX, ["--extra"]);
    expect(args[0]).toBe(SANDBOX.workspaceDir);
    for (const arg of TEST_EDITOR_ARGUMENTS) expect(args).toContain(arg);
    expect(args).toContain("--extra");
    expect(args).toContain(`--extensionTestsPath=${suiteBundlePath(pkg)}`);
    expect(args[args.length - 1]).toBe(`--extensionDevelopmentPath=${pkg}`);
  });

  it("works without extra arguments", () => {
    expect(testEditorArguments("/p", SANDBOX)).not.toContain("--extra");
  });
});

describe("processesMentioning", () => {
  it("finds no process for a marker nothing carries", () => {
    expect(processesMentioning(`oti-no-such-marker-${process.pid}-${Date.now()}`)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "finds a process whose command line has the marker",
    async () => {
      const marker = `oti-marker-${process.pid}-${Date.now()}`;
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", marker], {
        stdio: "ignore",
      });
      try {
        await new Promise((resolve) => child.once("spawn", resolve));
        expect(processesMentioning(marker)).toEqual([child.pid]);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
