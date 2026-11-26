import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_FOLDER,
  FIXTURES_DIR,
  MANIFEST_FILE,
  checkFixtureTree,
  isFixtureTreeCurrent,
  listFiles,
  renderFixtureTree,
  writeFixtureTree,
} from "../src/index.js";
import { makeTempDir, removeTempDirs } from "./tmp.js";

afterEach(removeTempDirs);

const onDisk = (dir: string, relative: string): string => join(dir, ...relative.split("/"));

describe("writeFixtureTree", () => {
  it("writes every generated file with the generator's bytes", () => {
    const dir = makeTempDir();
    const written = writeFixtureTree(dir);
    const files = renderFixtureTree();
    expect(written).toEqual(files.map((file) => file.path));
    for (const file of files) {
      expect(readFileSync(onDisk(dir, file.path), "utf8")).toBe(file.content);
    }
    expect(existsSync(join(dir, CONFIG_FOLDER, "projects"))).toBe(true);
  });

  it("writes the same bytes on a second run and into a second folder", () => {
    const first = makeTempDir();
    const second = makeTempDir();
    writeFixtureTree(first);
    writeFixtureTree(first);
    const paths = writeFixtureTree(second);
    for (const path of paths) {
      expect(readFileSync(onDisk(first, path)).equals(readFileSync(onDisk(second, path)))).toBe(
        true,
      );
    }
    expect(isFixtureTreeCurrent(checkFixtureTree(first))).toBe(true);
  });

  it("replaces the config folder and leaves other files of the folder alone", () => {
    const dir = makeTempDir();
    const stale = join(dir, CONFIG_FOLDER, "projects", "-workspace-old", "old.jsonl");
    mkdirSync(join(dir, CONFIG_FOLDER, "projects", "-workspace-old"), { recursive: true });
    writeFileSync(stale, "{}\n");
    writeFileSync(join(dir, "README.md"), "kept\n");
    writeFixtureTree(dir);
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("kept\n");
  });

  it("writes another set for another seed, and creates the folder when it is missing", () => {
    const dir = join(makeTempDir(), "nested", "fixtures");
    writeFixtureTree(dir, { seed: "elsewhere" });
    expect(isFixtureTreeCurrent(checkFixtureTree(dir, { seed: "elsewhere" }))).toBe(true);
    const againstDefault = checkFixtureTree(dir);
    expect(againstDefault.changed).toEqual([MANIFEST_FILE]);
    expect(againstDefault.missing.length).toBeGreaterThan(0);
    expect(againstDefault.extra.length).toBe(againstDefault.missing.length);
  });
});

describe("checkFixtureTree", () => {
  it("reports nothing for a folder the generator just wrote", () => {
    const dir = makeTempDir();
    writeFixtureTree(dir);
    const diff = checkFixtureTree(dir);
    expect(diff).toEqual({ missing: [], changed: [], extra: [] });
    expect(isFixtureTreeCurrent(diff)).toBe(true);
  });

  it("reports every file as missing for an empty folder", () => {
    const diff = checkFixtureTree(makeTempDir());
    expect(diff.missing).toEqual(renderFixtureTree().map((file) => file.path));
    expect(diff.changed).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(isFixtureTreeCurrent(diff)).toBe(false);
  });

  it("reports a missing file, a changed file and a file the generator does not write", () => {
    const dir = makeTempDir();
    const paths = writeFixtureTree(dir);
    const transcripts = paths.filter((path) => path.endsWith(".jsonl"));
    const [removed, edited] = transcripts as [string, string];
    rmSync(onDisk(dir, removed));
    // One byte more is a change: the comparison is byte for byte.
    writeFileSync(onDisk(dir, edited), `${readFileSync(onDisk(dir, edited), "utf8")}\n`);
    const added = `${CONFIG_FOLDER}/projects/-workspace-extra/added.jsonl`;
    mkdirSync(join(dir, CONFIG_FOLDER, "projects", "-workspace-extra"));
    writeFileSync(onDisk(dir, added), "{}\n");
    writeFileSync(join(dir, "README.md"), "not part of the generated tree\n");

    const diff = checkFixtureTree(dir);
    expect(diff).toEqual({ missing: [removed], changed: [edited], extra: [added] });
    expect(isFixtureTreeCurrent(diff)).toBe(false);
  });
});

describe("listFiles", () => {
  it("lists every file below a folder, sorted by name, under the prefix it is given", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "b", "deep"), { recursive: true });
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "z.txt"), "");
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, "b", "two.txt"), "");
    writeFileSync(join(dir, "b", "deep", "one.txt"), "");
    expect(listFiles(dir, "top")).toEqual([
      "top/a.txt",
      "top/b/deep/one.txt",
      "top/b/two.txt",
      "top/z.txt",
    ]);
  });

  it("returns nothing for an empty folder and for a folder that does not exist", () => {
    const dir = makeTempDir();
    expect(listFiles(dir, "top")).toEqual([]);
    expect(listFiles(join(dir, "absent"), "top")).toEqual([]);
  });

  it("sorts the entries of each folder by name, a folder among the files beside it", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "session"));
    writeFileSync(join(dir, "session.jsonl"), "");
    writeFileSync(join(dir, "session", "agent.jsonl"), "");
    expect(listFiles(dir, "top")).toEqual(["top/session/agent.jsonl", "top/session.jsonl"]);
  });

  it("lists exactly the files the generator wrote into the config folder", () => {
    const dir = makeTempDir();
    const written = writeFixtureTree(dir).filter((path) => path !== MANIFEST_FILE);
    const listed = listFiles(join(dir, CONFIG_FOLDER), CONFIG_FOLDER);
    expect([...listed].sort()).toEqual([...written].sort());
  });
});

describe("isFixtureTreeCurrent", () => {
  it("is true only when all three lists are empty", () => {
    expect(isFixtureTreeCurrent({ missing: [], changed: [], extra: [] })).toBe(true);
    expect(isFixtureTreeCurrent({ missing: ["a"], changed: [], extra: [] })).toBe(false);
    expect(isFixtureTreeCurrent({ missing: [], changed: ["a"], extra: [] })).toBe(false);
    expect(isFixtureTreeCurrent({ missing: [], changed: [], extra: ["a"] })).toBe(false);
  });
});

describe("the committed fixtures", () => {
  it("are exactly what the generator writes with the default seed", () => {
    // When this fails, the generator changed: run `npm run generate -w @orbitrace/fixtures`
    // and commit the result.
    expect(checkFixtureTree(FIXTURES_DIR)).toEqual({ missing: [], changed: [], extra: [] });
  });
});
