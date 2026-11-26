import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { DEFAULT_SEED, FIXTURES_DIR, MANIFEST_FILE, renderFixtureTree } from "../src/index.js";
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

describe("runCli", () => {
  it("writes the fixtures into the folder given with --out", () => {
    const dir = makeTempDir();
    const io = capture();
    expect(runCli(["--out", dir], io)).toBe(0);
    const count = renderFixtureTree().length;
    expect(io.out).toEqual([`wrote ${count} fixture file(s) with seed "${DEFAULT_SEED}"`]);
    expect(io.err).toEqual([]);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(true);
  });

  it("--check passes for a folder it just wrote", () => {
    const dir = makeTempDir();
    runCli(["--out", dir], capture());
    const io = capture();
    expect(runCli(["--check", "--out", dir], io)).toBe(0);
    expect(io.out).toEqual(["fixtures match the generator"]);
    expect(io.err).toEqual([]);
  });

  it("--check fails with status 1 and names each file that differs", () => {
    const dir = makeTempDir();
    runCli(["--out", dir], capture());
    appendFileSync(join(dir, MANIFEST_FILE), "\n");
    const io = capture();
    expect(runCli(["--out", dir, "--check"], io)).toBe(1);
    expect(io.err).toEqual([
      `changed: ${MANIFEST_FILE}`,
      "fixtures differ from the generator. Run: npm run generate -w @orbitrace/fixtures",
    ]);
    expect(io.out).toEqual([]);

    const empty = capture();
    expect(runCli(["--check", "--out", makeTempDir()], empty)).toBe(1);
    expect(empty.err[0]).toBe(`missing: ${MANIFEST_FILE}`);
    expect(empty.err).toHaveLength(renderFixtureTree().length + 1);
  });

  it("--check does not write anything", () => {
    const dir = makeTempDir();
    expect(runCli(["--check", "--out", dir], capture())).toBe(1);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  it("--seed writes and checks another set", () => {
    const dir = makeTempDir();
    const io = capture();
    expect(runCli(["--seed", "elsewhere", "--out", dir], io)).toBe(0);
    expect(io.out[0]).toContain('with seed "elsewhere"');
    expect(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))).toMatchObject({
      seed: "elsewhere",
    });
    expect(runCli(["--check", "--seed", "elsewhere", "--out", dir], capture())).toBe(0);
    const notExtra = capture();
    expect(runCli(["--check", "--out", dir], notExtra)).toBe(1);
    expect(notExtra.err.some((line) => line.startsWith("not generated: "))).toBe(true);
  });

  it("returns status 2 and the usage line for bad arguments", () => {
    for (const argv of [["--nope"], ["--out"], ["--seed"], ["extra"]]) {
      const io = capture();
      expect(runCli(argv, io)).toBe(2);
      expect(io.err).toHaveLength(2);
      expect(io.err[0]).toMatch(
        /^fixtures: (unknown argument|--out needs a value|--seed needs a value)/,
      );
      expect(io.err[1]).toBe("usage: node dist/cli.js [--check] [--out <dir>] [--seed <seed>]");
      expect(io.out).toEqual([]);
    }
  });

  it("checks the committed fixtures when no folder is given", () => {
    const io = capture();
    expect(runCli(["--check"], io)).toBe(0);
    expect(io.out).toEqual(["fixtures match the generator"]);
    expect(existsSync(join(FIXTURES_DIR, MANIFEST_FILE))).toBe(true);
  });
});
