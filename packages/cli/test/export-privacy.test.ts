/**
 * Ticket #23: what `orbitrace export` writes, to the file, to stdout and to stderr, for a
 * synthetic session whose project folder, session id, working directory, branch, title, text
 * and subagent descriptions all hold invented marker strings. Nothing marked may appear in
 * any output: the file name is fixed, messages show only what the user typed, and the replay
 * holds structure only. Findings: docs/security/export-audit.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateReplay } from "@orbitrace/core";
import { generateSession } from "@orbitrace/fixtures/generator";
import { run, type CliIo } from "../src/cli.js";
import type { HostContext } from "../src/sessions.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

/** Every invented marker holds this token; finding it in any letter case is a leak. */
const TOKEN = "zqx";
const MARKED_TEXT = "Zqx prompt: move the private zqx ledger, ask zqx.person@example.com";
// Assembled from parts so this file holds nothing shaped like a real home-folder path.
const MARKED_PATH = ["", "home", "zqxuser", "zqx-client"].join("/");
const MARKED_PROJECT_FOLDER = "-home-zqxuser-zqx-client";
const MARKED_SESSION = "zqx-session-0001";

const CONTENT_KEYS = new Set(["text", "thinking", "aiTitle", "description", "lastPrompt"]);

/** Plant markers in every content field and as an extra key of every object. */
function mark(value: unknown, sessionId: string): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => mark(item, sessionId));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "cwd") out[key] = MARKED_PATH;
    else if (key === "gitBranch") out[key] = `zqx/${MARKED_TEXT}`;
    else if (key === "sessionId" && item === sessionId) out[key] = MARKED_SESSION;
    else if (CONTENT_KEYS.has(key) || (key === "content" && typeof item === "string")) {
      out[key] = MARKED_TEXT;
    } else out[key] = mark(item, sessionId);
  }
  out[MARKED_TEXT] = MARKED_PATH;
  return out;
}

function hasToken(text: string): boolean {
  return text.toLowerCase().includes(TOKEN);
}

let configDir: string;
let workDir: string;
let host: HostContext;

beforeAll(() => {
  const root = makeTempDir();
  configDir = join(root, "config");
  workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const session = generateSession("nested-subagents");
  for (const file of session.files) {
    const path = file.path
      .split(session.projectDir)
      .join(MARKED_PROJECT_FOLDER)
      .split(session.sessionId)
      .join(MARKED_SESSION);
    const content = file.path.endsWith(".jsonl")
      ? file.content
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.stringify(mark(JSON.parse(line), session.sessionId)))
          .join("\n") + "\n"
      : `${JSON.stringify(mark(JSON.parse(file.content), session.sessionId))}\n`;
    const target = join(configDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  host = { platform: process.platform, homeDir: join(root, "home"), env: {}, cwd: workDir };
});

afterAll(() => {
  removeTempDirs();
});

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await run(argv, io, host);
  return { code, stdout, stderr };
}

describe("orbitrace export with marked session data", () => {
  it("plants markers that the session really holds", () => {
    const listed = readFileSync(
      join(configDir, "projects", MARKED_PROJECT_FOLDER, `${MARKED_SESSION}.jsonl`),
      "utf8",
    );
    expect(hasToken(listed)).toBe(true);
  });

  it("writes a replay to stdout with no marker in it", async () => {
    const result = await capture(["export", "--latest", "--config-dir", configDir]);
    expect(result.code).toBe(0);
    expect(validateReplay(JSON.parse(result.stdout))).toBe(true);
    expect(hasToken(result.stdout)).toBe(false);
    expect(hasToken(result.stderr)).toBe(false);
  });

  it("writes the file under the fixed name and prints only the path that was typed", async () => {
    const result = await capture(["export", "--latest", "--config-dir", configDir, "-o", "."]);
    expect(result.code).toBe(0);
    const data = readFileSync(join(workDir, "orbitrace.replay.json"), "utf8");
    expect(validateReplay(JSON.parse(data))).toBe(true);
    expect(hasToken(data)).toBe(false);
    expect(result.stdout).toBe(`Wrote orbitrace.replay.json (${Buffer.byteLength(data)} bytes).\n`);
    expect(hasToken(result.stderr)).toBe(false);
    expect(result.stderr).toContain("check them before you share it");
  });

  it("puts only an opaque key, the replay and counts in the --json document", async () => {
    const result = await capture(["export", "--latest", "--config-dir", configDir, "--json"]);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["key", "fileName", "output", "bytes", "warnings", "replay"]);
    expect(doc["key"]).toMatch(/^claude-code:[0-9a-f]{32}$/);
    expect(hasToken(result.stdout)).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("does not echo session data in an error", async () => {
    const result = await capture(["export", "claude-code:ffffffff", "--config-dir", configDir]);
    expect(result.code).not.toBe(0);
    expect(hasToken(result.stderr)).toBe(false);
    expect(result.stdout).toBe("");
  });
});
