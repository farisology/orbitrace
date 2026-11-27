import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSessionReplayer } from "@orbitrace/core/node";
import { createSessionCatalog } from "../src/session-catalog.js";
import {
  createSandbox,
  editorArguments,
  editorEnvironment,
  isInheritedEditorVariable,
  readSandbox,
  removeSandbox,
  SANDBOX_ENV,
  SANDBOX_FILE,
  SANDBOX_USER_SETTINGS,
  WORKSPACE_SESSION_AGE_MS,
  writeWorkspaceSession,
  type SandboxDescription,
} from "./sandbox.js";
import {
  appendSuiteLog,
  readSuiteResult,
  SUITE_LOG_FILE,
  SUITE_RESULT_FILE,
  writeSuiteResult,
} from "./sandbox-description.js";

const parents: string[] = [];

/** A new temporary parent folder, deleted after the test. */
function parent(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oti-test-")));
  parents.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of parents.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A replayer over the sandbox's config folder only. */
function replayerFor(sandbox: SandboxDescription) {
  return createNodeSessionReplayer({
    roots: [
      {
        runtime: "claude-code",
        root: sandbox.configDir,
        resolvedBy: "user-setting",
        available: true,
      },
    ],
  });
}

describe("createSandbox", () => {
  it("lays out every folder below one new temporary folder and describes it", () => {
    const sandbox = createSandbox(parent());
    for (const dir of [
      sandbox.configDir,
      sandbox.homeDir,
      sandbox.workspaceDir,
      sandbox.userDataDir,
      sandbox.extensionsDir,
    ]) {
      expect(dir.startsWith(`${sandbox.root}`)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    }
    expect(readSandbox(sandbox.root)).toEqual(sandbox);
    expect(existsSync(join(sandbox.workspaceDir, "README.md"))).toBe(true);
    expect(existsSync(sandbox.workspaceSession.transcript)).toBe(true);
    for (const session of sandbox.otherSessions) expect(existsSync(session.transcript)).toBe(true);
    expect(sandbox.otherSessions.length).toBeGreaterThan(1);
  });

  it("writes user settings that turn telemetry and update checks off", () => {
    const sandbox = createSandbox(parent());
    const settings = JSON.parse(
      readFileSync(join(sandbox.userDataDir, "User", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings).toEqual(SANDBOX_USER_SETTINGS);
    expect(settings["telemetry.telemetryLevel"]).toBe("off");
  });

  it("keeps the folder short enough for the editor's IPC socket on macOS", () => {
    const sandbox = createSandbox(parent());
    // The editor's main socket is `<user-data>/<version>-main.sock`; macOS allows 103 bytes,
    // so the sandbox adds as little as it can to the temporary folder's path.
    expect(basename(sandbox.root)).toMatch(/^oti-.{6}$/);
    expect(sandbox.userDataDir).toBe(join(sandbox.root, "ud"));
  });

  it("gives the keys the extension's replayer lists, workspace session last by time", async () => {
    const sandbox = createSandbox(parent());
    const listed = await replayerFor(sandbox).list();
    const keys = listed.map((summary) => summary.key);
    expect([...keys].sort()).toEqual(
      [sandbox.workspaceSession.key, ...sandbox.otherSessions.map((s) => s.key)].sort(),
    );
    expect(keys[keys.length - 1]).toBe(sandbox.workspaceSession.key);
    const ws = listed.find((summary) => summary.key === sandbox.workspaceSession.key);
    expect(ws?.projectLabel).toBe(sandbox.workspaceSession.projectLabel);
  });

  it("files exactly one session under the workspace folder, as the catalog sees it", async () => {
    const sandbox = createSandbox(parent());
    const entries = await createSessionCatalog(replayerFor(sandbox)).list([sandbox.workspaceDir]);
    expect(entries.filter((entry) => entry.inWorkspace).map((entry) => entry.summary.key)).toEqual([
      sandbox.workspaceSession.key,
    ]);
    expect(entries[0]?.summary.key).toBe(sandbox.workspaceSession.key);
  });

  it("throws when the parent folder cannot hold it", () => {
    const base = parent();
    const blocked = join(base, "not-a-folder");
    writeFileSync(blocked, "x");
    expect(() => createSandbox(blocked)).toThrow();
  });
});

describe("writeWorkspaceSession", () => {
  it("dates every file of the session before now", () => {
    const sandbox = createSandbox(parent());
    const now = Date.now();
    const session = writeWorkspaceSession(sandbox.configDir, join(sandbox.root, "other-ws"), now);
    const age = now - statSync(session.transcript).mtimeMs;
    expect(Math.abs(age - WORKSPACE_SESSION_AGE_MS)).toBeLessThan(2_000);
    expect(session.key).toMatch(/^claude-code:[0-9a-f]{32}$/);
  });
});

describe("removeSandbox", () => {
  it("deletes the sandbox and is safe to call twice", () => {
    const sandbox = createSandbox(parent());
    removeSandbox(sandbox);
    expect(existsSync(sandbox.root)).toBe(false);
    expect(() => removeSandbox(sandbox)).not.toThrow();
  });
});

describe("editorEnvironment and editorArguments", () => {
  it("drop the variables of another editor window and keep the rest", () => {
    const sandbox = createSandbox(parent());
    const env = editorEnvironment(sandbox, {
      PATH: "/usr/bin",
      VSCODE_IPC_HOOK: "/tmp/other.sock",
      VSCODE_CODE_CACHE_PATH: "/tmp/cache",
      ELECTRON_RUN_AS_NODE: "1",
      CLAUDE_CONFIG_DIR: "/tmp/not-this-one",
      HOME: "/tmp/not-this-home",
      EMPTY: undefined,
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(Object.keys(env).filter(isInheritedEditorVariable)).toEqual([]);
    expect(env.CLAUDE_CONFIG_DIR).toBe(sandbox.configDir);
    expect(env.HOME).toBe(sandbox.homeDir);
    expect("EMPTY" in env).toBe(false);
  });

  it("isInheritedEditorVariable names VSCODE_ and ELECTRON_ variables only", () => {
    expect(isInheritedEditorVariable("VSCODE_PID")).toBe(true);
    expect(isInheritedEditorVariable("ELECTRON_RUN_AS_NODE")).toBe(true);
    expect(isInheritedEditorVariable("CLAUDE_CONFIG_DIR")).toBe(false);
    expect(isInheritedEditorVariable("MY_VSCODE_THING")).toBe(false);
  });

  it("point the config folder and home folder into the sandbox", () => {
    const sandbox = createSandbox(parent());
    expect(editorEnvironment(sandbox)).toEqual({
      CLAUDE_CONFIG_DIR: sandbox.configDir,
      HOME: sandbox.homeDir,
      USERPROFILE: sandbox.homeDir,
      [SANDBOX_ENV]: sandbox.root,
    });
  });

  it("open the workspace with a sandboxed profile, no user environment and no keychain", () => {
    const sandbox = createSandbox(parent());
    const args = editorArguments(sandbox);
    expect(args[0]).toBe(sandbox.workspaceDir);
    expect(args).toContain(`--user-data-dir=${sandbox.userDataDir}`);
    expect(args).toContain(`--extensions-dir=${sandbox.extensionsDir}`);
    for (const flag of [
      "--disable-extensions",
      "--force-disable-user-env",
      "--use-inmemory-secretstorage",
      "--disable-telemetry",
      "--disable-crash-reporter",
    ]) {
      expect(args).toContain(flag);
    }
  });
});

describe("readSandbox", () => {
  it("throws when the description is missing or incomplete", () => {
    const dir = parent();
    expect(() => readSandbox(dir)).toThrow(`no ${SANDBOX_FILE}`);
    writeFileSync(join(dir, SANDBOX_FILE), JSON.stringify({ root: dir }));
    expect(() => readSandbox(dir)).toThrow("has no configDir");
    const paths = {
      root: dir,
      configDir: dir,
      homeDir: dir,
      workspaceDir: dir,
      userDataDir: dir,
      extensionsDir: dir,
    };
    writeFileSync(join(dir, SANDBOX_FILE), JSON.stringify(paths));
    expect(() => readSandbox(dir)).toThrow("has no sessions");
  });
});

describe("suite log and result", () => {
  it("appends log lines", () => {
    const dir = parent();
    appendSuiteLog(dir, "one");
    appendSuiteLog(dir, "two");
    expect(readFileSync(join(dir, SUITE_LOG_FILE), "utf8")).toBe("one\ntwo\n");
  });

  it("writes the counts and reads them back, with nothing else", () => {
    const dir = parent();
    expect(readSuiteResult(dir)).toBeNull();
    const extra = { passed: 3, failed: 1, skipped: 2, results: ["x"] };
    writeSuiteResult(dir, extra);
    expect(readSuiteResult(dir)).toEqual({ passed: 3, failed: 1, skipped: 2 });
    expect(existsSync(join(dir, `${SUITE_RESULT_FILE}.partial`))).toBe(false);
  });

  it("reads a malformed result as none", () => {
    const dir = parent();
    const file = join(dir, SUITE_RESULT_FILE);
    for (const text of [
      "{",
      "null",
      "[]",
      '{"passed":1,"failed":-1,"skipped":0}',
      '{"passed":1}',
    ]) {
      writeFileSync(file, text);
      expect(readSuiteResult(dir)).toBeNull();
    }
  });
});
