/**
 * The description of a sandbox that `sandbox.ts` writes and the suite reads inside the
 * editor. Kept apart from `sandbox.ts` so the suite bundle does not pull in the fixture
 * generator. No vscode dependency, so it is unit tested (`sandbox.test.ts`).
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Environment variable that tells the suite where the sandbox description is. */
export const SANDBOX_ENV = "ORBITRACE_IT_SANDBOX";

/** File, in the sandbox folder, that describes it to the suite. */
export const SANDBOX_FILE = "sandbox.json";

/** One synthetic session, as the suite needs it. */
export interface SandboxSession {
  /** The key the extension's replayer gives it. */
  readonly key: string;
  /** The invented project name the session's working directory ends in. */
  readonly projectLabel: string;
  /** Absolute path of its main transcript. */
  readonly transcript: string;
}

/** What the suite is told about the sandbox (written to `sandbox.json`). */
export interface SandboxDescription {
  readonly root: string;
  readonly configDir: string;
  readonly homeDir: string;
  readonly workspaceDir: string;
  readonly userDataDir: string;
  readonly extensionsDir: string;
  /**
   * The history store's data folder (`ORBITRACE_DATA_DIR` in the editor, #196). Not created by
   * the sandbox: the store creates it, and the suite checks that deleting the store removes it.
   */
  readonly historyDataDir: string;
  /** The session filed under the workspace folder. */
  readonly workspaceSession: SandboxSession;
  /** Every other session. */
  readonly otherSessions: readonly SandboxSession[];
}

/** Read a sandbox description written by `createSandbox` in `sandbox.ts`. Throws when it is missing or malformed. */
export function readSandbox(root: string): SandboxDescription {
  const file = join(root, SANDBOX_FILE);
  if (!existsSync(file)) throw new Error(`no ${SANDBOX_FILE} in the sandbox folder`);
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<SandboxDescription>;
  const paths = [
    "root",
    "configDir",
    "homeDir",
    "workspaceDir",
    "userDataDir",
    "extensionsDir",
    "historyDataDir",
  ] as const;
  for (const name of paths) {
    if (typeof value[name] !== "string" || value[name] === "") {
      throw new Error(`${SANDBOX_FILE} has no ${name}`);
    }
  }
  if (typeof value.workspaceSession?.key !== "string" || !Array.isArray(value.otherSessions)) {
    throw new Error(`${SANDBOX_FILE} has no sessions`);
  }
  return value as SandboxDescription;
}

/**
 * File, in the sandbox folder, that receives the suite's report lines. Recent VS Code versions
 * do not pass the extension host's console output on to the process that started the editor,
 * so the suite writes its lines here and the launcher prints them.
 */
export const SUITE_LOG_FILE = "suite.log";

/** File, in the sandbox folder, with the suite's counts. Written once, when the suite ends. */
export const SUITE_RESULT_FILE = "suite-result.json";

/** The counts the suite writes when it ends. */
export interface SuiteResult {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Append one line to the suite's log in the sandbox. */
export function appendSuiteLog(root: string, line: string): void {
  appendFileSync(join(root, SUITE_LOG_FILE), `${line}\n`, "utf8");
}

/**
 * Write the suite's counts. Written to a temporary name and then renamed, so the launcher,
 * which polls for the file, never reads half of it.
 */
export function writeSuiteResult(root: string, result: SuiteResult): void {
  const file = join(root, SUITE_RESULT_FILE);
  const partial = `${file}.partial`;
  const { passed, failed, skipped } = result;
  writeFileSync(partial, `${JSON.stringify({ passed, failed, skipped })}\n`, "utf8");
  renameSync(partial, file);
}

/** The suite's counts, or null when it has not written them (yet) or they are malformed. */
export function readSuiteResult(root: string): SuiteResult | null {
  const file = join(root, SUITE_RESULT_FILE);
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { passed, failed, skipped } = value as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!count(passed) || !count(failed) || !count(skipped)) return null;
  return { passed, failed, skipped };
}
