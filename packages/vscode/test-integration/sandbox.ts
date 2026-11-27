/**
 * The throwaway world one integration run happens in, all inside one new temporary folder:
 *
 * - `fx/config`: a Claude Code config folder written by the `@orbitrace/fixtures` generator
 *   (every scenario, invented data), plus one more session filed under the workspace
 *   folder's project name, so the workspace has a session of its own. The launched editor
 *   gets `CLAUDE_CONFIG_DIR` pointing here.
 * - `home`: the launched editor's home folder (`HOME`, `USERPROFILE`), empty, so neither the
 *   real `~/.claude` nor anything else in the real home folder is read.
 * - `ws`: the workspace folder the editor opens.
 * - `ud`, `ext`: the editor's user-data and extensions folders, so the user's own editor
 *   profile is never touched. `ud/User/settings.json` turns telemetry, update checks and the
 *   AI features off (`SANDBOX_USER_SETTINGS`).
 *
 * Folder names are short because the editor puts its IPC socket inside the user-data folder,
 * and macOS limits a socket path to 103 characters.
 *
 * The workspace session is older than every other session, so "workspace first" in the
 * Sessions view cannot be mistaken for "newest first".
 *
 * No vscode dependency, so it is unit tested (`sandbox.test.ts`).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCodeSessionKey } from "@orbitrace/core/node";
import { generateSession, writeFixtureTree, type FixtureManifest } from "@orbitrace/fixtures";
import { encodeProjectFolder } from "../src/workspace-match.js";
import {
  SANDBOX_ENV,
  SANDBOX_FILE,
  type SandboxDescription,
  type SandboxSession,
} from "./sandbox-description.js";

export {
  readSandbox,
  SANDBOX_ENV,
  SANDBOX_FILE,
  type SandboxDescription,
  type SandboxSession,
} from "./sandbox-description.js";

/** Scenario copied into the workspace's own project folder. Has subagents. */
export const WORKSPACE_SCENARIO = "two-waves";

/** Seed of the workspace session, so its session id differs from the committed fixture's. */
export const WORKSPACE_SEED = "orbitrace-integration-workspace";

/** How much older than the other sessions the workspace session is made. */
export const WORKSPACE_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * User settings of the launched editor: no telemetry, no update or extension update checks, no
 * start page, no AI features. Keeps the run quiet and offline apart from the VS Code download.
 */
export const SANDBOX_USER_SETTINGS: Readonly<Record<string, unknown>> = {
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "workbench.startupEditor": "none",
  "chat.disableAIFeatures": true,
};

/** A temporary folder that is a real path, so paths compare equal to the editor's. */
function realTempDir(parent: string, prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(parent), prefix)));
}

/** The project folder of a transcript path `projects/<project>/<file>` (forward slashes). */
function projectFolderOf(transcriptInConfig: string): string {
  const parts = transcriptInConfig.split("/");
  const folder = parts[1];
  if (parts[0] !== "projects" || folder === undefined) {
    throw new Error(`unexpected transcript path layout: ${transcriptInConfig}`);
  }
  return folder;
}

function toDisk(base: string, relative: string): string {
  return join(base, ...relative.split("/"));
}

/**
 * Write the workspace session: the `WORKSPACE_SCENARIO` session generated from
 * `WORKSPACE_SEED`, with every file moved into the project folder Claude Code would use for
 * `workspaceDir`. Every file is dated `WORKSPACE_SESSION_AGE_MS` before `now`.
 */
export function writeWorkspaceSession(
  configDir: string,
  workspaceDir: string,
  now: number,
): SandboxSession {
  const session = generateSession(WORKSPACE_SCENARIO, { seed: WORKSPACE_SEED });
  const folder = encodeProjectFolder(workspaceDir);
  const when = new Date(now - WORKSPACE_SESSION_AGE_MS);
  let transcript: string | null = null;
  for (const file of session.files) {
    const parts = file.path.split("/");
    if (parts[0] !== "projects" || parts.length < 3) {
      throw new Error(`unexpected generated file layout: ${file.path}`);
    }
    parts[1] = folder;
    const target = toDisk(configDir, parts.join("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
    utimesSync(target, when, when);
    if (file.path === session.transcriptPath) transcript = target;
  }
  if (transcript === null) throw new Error("the generated session has no main transcript");
  return {
    key: claudeCodeSessionKey(configDir, folder, session.sessionId),
    projectLabel: session.project,
    transcript,
  };
}

/** Create a sandbox under `parent` (default: the OS temporary folder). */
export function createSandbox(
  parent: string = tmpdir(),
  now: number = Date.now(),
): SandboxDescription {
  const root = realTempDir(parent, "oti-");
  try {
    const fixturesDir = join(root, "fx");
    const configDir = join(fixturesDir, "config");
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "ws");
    const userDataDir = join(root, "ud");
    const extensionsDir = join(root, "ext");
    for (const dir of [fixturesDir, homeDir, workspaceDir, userDataDir, extensionsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    mkdirSync(join(userDataDir, "User"), { recursive: true });
    writeFileSync(
      join(userDataDir, "User", "settings.json"),
      `${JSON.stringify(SANDBOX_USER_SETTINGS, null, 2)}\n`,
    );
    writeFixtureTree(fixturesDir);
    const manifest = JSON.parse(
      readFileSync(join(fixturesDir, "manifest.json"), "utf8"),
    ) as FixtureManifest;
    const otherSessions = manifest.sessions.map((session) => {
      // Manifest paths are relative to the fixtures folder: `config/projects/<project>/...`.
      const inConfig = session.transcript.replace(/^config\//, "");
      return {
        key: claudeCodeSessionKey(configDir, projectFolderOf(inConfig), session.sessionId),
        projectLabel: session.project,
        transcript: toDisk(configDir, inConfig),
      };
    });
    const workspaceSession = writeWorkspaceSession(configDir, workspaceDir, now);
    // A file in the workspace, so the editor has something ordinary to show.
    writeFileSync(
      join(workspaceDir, "README.md"),
      "Synthetic workspace for an integration test.\n",
    );
    const description: SandboxDescription = {
      root,
      configDir,
      homeDir,
      workspaceDir,
      userDataDir,
      extensionsDir,
      workspaceSession,
      otherSessions,
    };
    writeFileSync(join(root, SANDBOX_FILE), `${JSON.stringify(description, null, 2)}\n`);
    return description;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Delete the sandbox folder. Safe when it is already gone. */
export function removeSandbox(sandbox: Pick<SandboxDescription, "root">): void {
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Variables of the launcher's environment the editor must not inherit. When the launcher runs
 * in a terminal (or an agent) inside another VS Code window, that window's `VSCODE_*`
 * variables point at its own IPC socket, code cache (in the user's own profile folder) and
 * compile cache, and `ELECTRON_RUN_AS_NODE` would start the editor as plain Node.js.
 */
export function isInheritedEditorVariable(name: string): boolean {
  return /^(VSCODE_|ELECTRON_)/i.test(name);
}

/**
 * The whole environment the editor is launched with: the launcher's environment `base` without
 * the variables `isInheritedEditorVariable` names, plus the synthetic config folder, the empty
 * home folder, and where the suite finds the sandbox.
 */
export function editorEnvironment(
  sandbox: SandboxDescription,
  base: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isInheritedEditorVariable(name)) env[name] = value;
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: sandbox.configDir,
    HOME: sandbox.homeDir,
    USERPROFILE: sandbox.homeDir,
    [SANDBOX_ENV]: sandbox.root,
  };
}

/**
 * Editor arguments:
 *
 * - open the workspace folder, keep profile and extensions in the sandbox, no installed
 *   extensions (built-in ones still load), a new window;
 * - `--force-disable-user-env`: do not merge in the login shell's environment, which could set
 *   its own `CLAUDE_CONFIG_DIR` or `HOME`. The suite checks the environment it got first;
 * - `--use-inmemory-secretstorage`: keep secrets in memory instead of the OS keychain. Without
 *   it (seen with VS Code 1.148.0 on macOS, `HOME` pointing at the empty sandbox home) the
 *   editor's main process stops answering: webview pages, which it serves, never load, its
 *   debugging port accepts connections but never replies, and it does not quit by itself.
 *   Keychain access is the only thing this flag changes, so that is taken to be where it
 *   blocks. The flag also keeps the run away from the user's own keychain;
 * - `--disable-telemetry`, `--disable-crash-reporter`: nothing is sent anywhere.
 */
export function editorArguments(sandbox: SandboxDescription): string[] {
  return [
    sandbox.workspaceDir,
    `--user-data-dir=${sandbox.userDataDir}`,
    `--extensions-dir=${sandbox.extensionsDir}`,
    "--disable-extensions",
    "--force-disable-user-env",
    "--new-window",
    "--use-inmemory-secretstorage",
    "--disable-telemetry",
    "--disable-crash-reporter",
  ];
}
