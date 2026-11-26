import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../src/entry.js";
import { runGoldensCli } from "../src/goldens-cli.js";
import {
  GOLDENS_COMMAND,
  MANIFEST_FILE,
  REPLAYS_FOLDER,
  SCENARIO_NAMES,
  fixturePaths,
  goldenReplayPath,
  writeFixtureTree,
} from "../src/index.js";
import { makeTempDir, removeTempDirs } from "./tmp.js";

afterEach(removeTempDirs);

interface Captured extends CliIo {
  out: string[];
  err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

function tempFixtures(): string {
  const dir = makeTempDir();
  writeFixtureTree(dir);
  return dir;
}

const DIFFER = `golden replays differ from the pipeline. If the change is intended, run: ${GOLDENS_COMMAND}`;
const USAGE = "usage: node dist/goldens-cli.js [--check] [--fixtures <dir>]";

describe("runGoldensCli", () => {
  it("writes the goldens of the folder given with --fixtures", async () => {
    const dir = tempFixtures();
    const io = capture();
    expect(await runGoldensCli(["--fixtures", dir], io)).toBe(0);
    expect(io.out).toEqual([`wrote ${SCENARIO_NAMES.length} golden replay file(s)`]);
    expect(io.err).toEqual([]);
    for (const name of SCENARIO_NAMES) {
      expect(readFileSync(goldenReplayPath(name, dir), "utf8")).toBe(
        readFileSync(goldenReplayPath(name), "utf8"),
      );
    }
  });

  it("--check passes for a folder it just wrote", async () => {
    const dir = tempFixtures();
    await runGoldensCli(["--fixtures", dir], capture());
    const io = capture();
    expect(await runGoldensCli(["--check", "--fixtures", dir], io)).toBe(0);
    expect(io.out).toEqual(["golden replays match the pipeline"]);
    expect(io.err).toEqual([]);
  });

  it("--check fails with status 1 and says what differs in each file", async () => {
    const dir = tempFixtures();
    await runGoldensCli(["--fixtures", dir], capture());
    const path = goldenReplayPath("single-agent", dir);
    const edited = JSON.parse(readFileSync(path, "utf8")) as { totals: { replies: number } };
    const replies = edited.totals.replies;
    edited.totals.replies = 0;
    writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`);
    rmSync(goldenReplayPath("demo", dir));

    const io = capture();
    expect(await runGoldensCli(["--fixtures", dir, "--check"], io)).toBe(1);
    expect(io.err).toEqual([
      "missing: replays/demo.replay.json",
      "changed: replays/single-agent.replay.json",
      `  totals.replies: committed 0, regenerated ${replies}`,
      DIFFER,
    ]);
    expect(io.out).toEqual([]);
  });

  it("--check does not write anything", async () => {
    const dir = tempFixtures();
    const io = capture();
    expect(await runGoldensCli(["--check", "--fixtures", dir], io)).toBe(1);
    expect(io.err).toHaveLength(SCENARIO_NAMES.length + 1);
    expect(io.err[0]).toBe("missing: replays/single-agent.replay.json");
    expect(io.err.at(-1)).toBe(DIFFER);
    expect(existsSync(join(dir, REPLAYS_FOLDER))).toBe(false);
  });

  it("returns status 1 and the reason when the goldens cannot be built", async () => {
    const empty = capture();
    expect(await runGoldensCli(["--fixtures", makeTempDir()], empty)).toBe(1);
    expect(empty.err).toEqual([
      `goldens: ${MANIFEST_FILE} not found. Run: npm run generate -w @orbitrace/fixtures`,
    ]);
    expect(empty.out).toEqual([]);

    const dir = tempFixtures();
    rmSync(fixturePaths("mcp-tools", dir).transcript);
    for (const argv of [
      ["--fixtures", dir],
      ["--check", "--fixtures", dir],
    ]) {
      const io = capture();
      expect(await runGoldensCli(argv, io)).toBe(1);
      expect(io.err).toHaveLength(1);
      expect(io.err[0]).toContain('goldens: session "mcp-tools": the source adapter found 0');
      expect(io.out).toEqual([]);
    }
    expect(existsSync(join(dir, REPLAYS_FOLDER))).toBe(false);
  });

  it("returns status 2 and the usage line for bad arguments", async () => {
    for (const argv of [["--nope"], ["--fixtures"], ["extra"], ["--check", "--out", "x"]]) {
      const io = capture();
      expect(await runGoldensCli(argv, io)).toBe(2);
      expect(io.err).toHaveLength(2);
      expect(io.err[0]).toMatch(/^goldens: (unknown argument: |--fixtures needs a value)/);
      expect(io.err[1]).toBe(USAGE);
      expect(io.out).toEqual([]);
    }
  });

  it("checks the committed goldens when no folder is given", async () => {
    const io = capture();
    expect(await runGoldensCli(["--check"], io)).toBe(0);
    expect(io.out).toEqual(["golden replays match the pipeline"]);
    expect(io.err).toEqual([]);
  });
});
