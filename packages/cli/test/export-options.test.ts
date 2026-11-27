/**
 * Tickets #122 and #123: the opt-in flags of `orbitrace export` (`--opaque-names`,
 * `--round-times`, `--bucket-tokens`). Every run uses a fake machine in a temporary folder: an
 * empty home folder, an empty environment (in process) or `fakeEnv` (built binary, with
 * CLAUDE_CONFIG_DIR pointing at the synthetic config folder), so no real session is ever listed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isKnownModelId,
  OPAQUE_KEPT_TOOL_NAMES,
  validateReplay,
  type ReplayModel,
} from "@orbitrace/core";
import { goldenReplayPath, SCENARIO_NAMES } from "@orbitrace/fixtures";
import { run, toExportOptions, type CliIo } from "../src/cli.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import type { HostContext } from "../src/sessions.js";
import {
  makeFakeMachine,
  makeTempDir,
  removeTempDirs,
  runBin,
  type FakeMachine,
} from "./helpers.js";

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

function exportArgs(...extra: string[]): string[] {
  return ["export", "--latest", "--config-dir", machine.configDir, ...extra];
}

/** The names `--opaque-names` must hide, read from a plain export. */
function chosenNames(model: ReplayModel): string[] {
  const kept = new Set(OPAQUE_KEPT_TOOL_NAMES);
  const names = new Set<string>();
  for (const agent of model.agents) {
    if (agent.id !== "main") names.add(agent.name);
    if (agent.model !== null && !isKnownModelId(agent.model)) names.add(agent.model);
    for (const tool of agent.tools) {
      if (tool.name.startsWith("mcp:")) {
        if (tool.name !== "mcp:unknown") names.add(tool.name.slice(4));
      } else if (!kept.has(tool.name)) names.add(tool.name);
    }
  }
  return [...names];
}

describe("toExportOptions", () => {
  it("passes only what is not at its default", () => {
    expect(
      toExportOptions({ names: "as-written", roundTimes: null, bucketTokens: false }, false),
    ).toEqual({ pretty: false });
    expect(toExportOptions({ names: "opaque", roundTimes: 0.1, bucketTokens: true }, true)).toEqual(
      { pretty: true, names: "opaque", roundTimes: 0.1, bucketTokens: true },
    );
  });
});

describe("orbitrace export without the new flags", () => {
  it("writes every golden replay byte for byte", async () => {
    for (const name of SCENARIO_NAMES) {
      const one = makeFakeMachine([name]);
      const result = await capture(
        ["export", "--latest", "--config-dir", one.configDir, "--pretty"],
        { ...host, homeDir: one.home },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(readFileSync(goldenReplayPath(name), "utf8"));
    }
  });

  it("reports the default options in the --json document", async () => {
    const result = await capture(exportArgs("--json"));
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual([
      "key",
      "fileName",
      "output",
      "bytes",
      "warnings",
      "options",
      "replay",
    ]);
    expect(doc["options"]).toEqual({ names: "as-written", roundTimes: null, bucketTokens: false });
    const plain = await capture(exportArgs());
    expect(JSON.stringify(doc["replay"])).toBe(plain.stdout.trimEnd());
  });
});

describe("orbitrace export --opaque-names", () => {
  it("hides every chosen name and keeps a valid replay", async () => {
    const plain = JSON.parse((await capture(exportArgs())).stdout) as ReplayModel;
    const names = chosenNames(plain);
    expect(names.length).toBeGreaterThan(3);
    const result = await capture(exportArgs("--opaque-names"));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(validateReplay(JSON.parse(result.stdout))).toBe(true);
    for (const name of names) expect(result.stdout.includes(name)).toBe(false);
    expect(result.stdout).toContain('"agent-1"');
  });

  it("prints the opaque share note after -o and reports the option in --json", async () => {
    const outDir = makeTempDir();
    const written = await capture(exportArgs("--opaque-names", "-o", "replay.json"), {
      ...host,
      cwd: outDir,
    });
    expect(written.code).toBe(0);
    expect(written.stdout).toMatch(/^Wrote replay\.json \(\d+ bytes\)\.\n$/);
    expect(written.stderr).toContain("replaced by numbered labels");
    expect(written.stderr).not.toContain("check them before you share it");
    const data = readFileSync(join(outDir, "replay.json"), "utf8");
    expect(validateReplay(JSON.parse(data))).toBe(true);

    const json = await capture(exportArgs("--opaque-names", "-o", "again.json", "--json"), {
      ...host,
      cwd: outDir,
    });
    const doc = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["key", "fileName", "output", "bytes", "warnings", "options"]);
    expect(doc["options"]).toEqual({ names: "opaque", roundTimes: null, bucketTokens: false });
    expect(readFileSync(join(outDir, "again.json"), "utf8")).toBe(data);
  });
});

describe("orbitrace export --round-times and --bucket-tokens", () => {
  it("rounds every time to the step", async () => {
    const result = await capture(exportArgs("--round-times", "0.5", "--json"));
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout) as { options: unknown; replay: ReplayModel };
    expect(doc.options).toEqual({ names: "as-written", roundTimes: 0.5, bucketTokens: false });
    expect(validateReplay(doc.replay)).toBe(true);
    const times: number[] = [doc.replay.totals.duration, doc.replay.totals.realDuration];
    for (const agent of doc.replay.agents) {
      times.push(agent.start, ...(agent.end === null ? [] : [agent.end]));
      for (const t of agent.tools) times.push(t.start, ...(t.end === null ? [] : [t.end]));
      for (const r of agent.replies) times.push(r.t);
    }
    for (const w of doc.replay.warps) times.push(w.at, w.skipped);
    expect(times.length).toBeGreaterThan(50);
    for (const time of times) expect(Number.isInteger(time * 2)).toBe(true);
  });

  it("buckets token counts and keeps totals equal to their parts", async () => {
    const result = await capture(exportArgs("--bucket-tokens", "--json"));
    const doc = JSON.parse(result.stdout) as { options: unknown; replay: ReplayModel };
    expect(doc.options).toEqual({ names: "as-written", roundTimes: null, bucketTokens: true });
    expect(validateReplay(doc.replay)).toBe(true);
    let sum = 0;
    for (const agent of doc.replay.agents) {
      for (const reply of agent.replies) {
        expect(String(reply.outputTokens)).toMatch(/^(0|[125]0*)$/);
        sum += reply.outputTokens;
      }
    }
    expect(doc.replay.totals.outputTokens).toBe(sum);
  });

  it("refuses a bad step with a usage error before reading any session", async () => {
    for (const value of ["0", "abc", "0.0001", "9999"]) {
      const result = await capture(exportArgs("--round-times", value, "--json"));
      expect(result.code).toBe(CLI_EXIT_CODES.usage);
      expect(result.stdout).toBe("");
      const error = (JSON.parse(result.stderr) as { error: { code: string; message: string } })
        .error;
      expect(error.code).toBe("usage");
      expect(error.message).toContain("--round-times");
    }
  });
});

describe("orbitrace export with every new flag (built binary)", () => {
  it("writes a valid replay with no chosen name, and reports the options", () => {
    const env = { CLAUDE_CONFIG_DIR: machine.configDir };
    const plain = runBin(["export", "--latest"], { home: machine.home, env });
    expect(plain.status).toBe(0);
    const names = chosenNames(JSON.parse(plain.stdout) as ReplayModel);
    const result = runBin(
      ["export", "--latest", "--opaque-names", "--round-times", "0.1", "--bucket-tokens", "--json"],
      { home: machine.home, env },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const doc = JSON.parse(result.stdout) as { options: unknown; replay: unknown };
    expect(doc.options).toEqual({ names: "opaque", roundTimes: 0.1, bucketTokens: true });
    expect(validateReplay(doc.replay)).toBe(true);
    const text = JSON.stringify(doc.replay);
    for (const name of names) expect(text.includes(name)).toBe(false);
  });

  it("lists the new flags in the help", () => {
    const result = runBin(["export", "--help"], { home: machine.home });
    expect(result.status).toBe(0);
    for (const flag of ["--opaque-names", "--round-times <seconds>", "--bucket-tokens"]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain("None of them hides the structure");
  });
});
