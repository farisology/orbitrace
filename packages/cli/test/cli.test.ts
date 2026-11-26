/**
 * `run` in-process, with a fake host (temporary home folder, empty environment), so the output
 * rules can be checked without a child process. binary.test.ts runs the built command.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateReplay } from "@orbitrace/core";
import { run, type CliIo } from "../src/cli.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import type { HostContext } from "../src/sessions.js";
import { statusLine } from "../src/version.js";
import { makeFakeMachine, makeTempDir, removeTempDirs, type FakeMachine } from "./helpers.js";

let machine: FakeMachine;
let host: HostContext;

beforeAll(() => {
  machine = makeFakeMachine();
  host = { platform: process.platform, homeDir: machine.home, env: {}, cwd: machine.root };
});

afterAll(() => {
  removeTempDirs();
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function capture(argv: string[], context: HostContext = host): Promise<Captured> {
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
  const code = await run(argv, io, context);
  return { code, stdout, stderr };
}

describe("run", () => {
  it("prints the version line", async () => {
    expect(await capture(["--version"])).toEqual({
      code: 0,
      stdout: `${statusLine()}\n`,
      stderr: "",
    });
  });

  it("writes exactly one JSON line to stdout for every command under --json", async () => {
    const commands = [
      ["--version", "--json"],
      ["help", "--json"],
      ["list", "--json", "--config-dir", machine.configDir],
      ["export", "--latest", "--json", "--config-dir", machine.configDir],
    ];
    for (const argv of commands) {
      const result = await capture(argv);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    }
  });

  it("writes errors as one JSON object on stderr and nothing on stdout under --json", async () => {
    const result = await capture(["export", "abcdef", "--json", "--config-dir", machine.configDir]);
    expect(result.code).toBe(CLI_EXIT_CODES["not-found"]);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "not-found",
        exitCode: 3,
        message: "No session with that key.",
        hint: "Run 'orbitrace list' to see the session keys.",
      },
    });
  });

  it("writes a usage error as text without --json", async () => {
    const result = await capture(["list", "--nope"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^orbitrace: .*--nope.* \[usage\]\nRun 'orbitrace list --help'/);
  });

  it("keeps warnings inside the JSON document under --json", async () => {
    const result = await capture([
      "export",
      "--latest",
      "--json",
      "--config-dir",
      "gone",
      "--config-dir",
      machine.configDir,
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const doc = JSON.parse(result.stdout) as { warnings: { code: string }[]; replay: unknown };
    expect(doc.warnings.map((warning) => warning.code)).toEqual(["config-dir-unavailable"]);
    expect(validateReplay(doc.replay)).toBe(true);
  });

  it("writes an export file and a share note", async () => {
    const outDir = makeTempDir();
    const result = await capture(
      ["export", "--latest", "-o", "replay.json", "--config-dir", machine.configDir],
      { ...host, cwd: outDir },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Wrote replay\.json \(\d+ bytes\)\.\n$/);
    expect(result.stderr).toContain("structure only");
    expect(validateReplay(JSON.parse(readFileSync(join(outDir, "replay.json"), "utf8")))).toBe(
      true,
    );
  });

  it("does not search the home folder's config folder when it is empty", async () => {
    const result = await capture(["list", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({ sessions: [], warnings: [] });
  });
});
