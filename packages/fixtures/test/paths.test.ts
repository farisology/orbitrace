import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEMO_SCENARIO,
  FIXTURES_DIR,
  FIXTURE_CONFIG_DIR,
  FIXTURE_MANIFEST_PATH,
  SCENARIO_NAMES,
  demoFixturePaths,
  fixturePaths,
  generateSession,
  writeFixtureTree,
  type FixtureManifest,
} from "../src/index.js";
import { parseJsonl } from "./helpers.js";
import { makeTempDir, removeTempDirs } from "./tmp.js";

afterEach(removeTempDirs);

describe("fixture folders", () => {
  it("point at fixtures/ at the repository root", () => {
    expect(isAbsolute(FIXTURES_DIR)).toBe(true);
    const root = dirname(FIXTURES_DIR);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces?: string[];
    };
    expect(manifest.workspaces).toEqual(["packages/*"]);
    expect(FIXTURES_DIR).toBe(join(root, "fixtures"));
    expect(FIXTURE_CONFIG_DIR).toBe(join(FIXTURES_DIR, "config"));
    expect(FIXTURE_MANIFEST_PATH).toBe(join(FIXTURES_DIR, "manifest.json"));
    expect(statSync(join(FIXTURE_CONFIG_DIR, "projects")).isDirectory()).toBe(true);
  });

  it("hold a manifest that lists every scenario with files that exist", () => {
    const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8")) as FixtureManifest;
    expect(manifest.sessions.map((session) => session.name)).toEqual([...SCENARIO_NAMES]);
    const listed = manifest.sessions.flatMap((session) => [
      session.transcript,
      ...session.subagents.flatMap((subagent) => [subagent.transcript, subagent.meta]),
    ]);
    const missing = listed.filter((path) => !existsSync(join(FIXTURES_DIR, ...path.split("/"))));
    expect(missing).toEqual([]);
  });
});

describe("fixturePaths", () => {
  it.each(SCENARIO_NAMES)("gives the files of %s, and they are on disk", (name) => {
    const paths = fixturePaths(name);
    const session = generateSession(name);
    expect(paths.name).toBe(name);
    expect(paths.sessionId).toBe(session.sessionId);
    expect(paths.configDir).toBe(FIXTURE_CONFIG_DIR);
    expect(paths.projectDir).toBe(join(FIXTURE_CONFIG_DIR, "projects", session.projectDir));
    expect(paths.transcript).toBe(join(paths.projectDir, `${session.sessionId}.jsonl`));
    expect(readFileSync(paths.transcript, "utf8")).toBe(session.files[0]?.content);

    expect(paths.subagents.map((subagent) => subagent.agentId)).toEqual(
      session.subagents.map((subagent) => subagent.agentId),
    );
    for (const subagent of paths.subagents) {
      const folder = join(paths.projectDir, session.sessionId, "subagents");
      expect(subagent.transcript).toBe(join(folder, `agent-${subagent.agentId}.jsonl`));
      expect(subagent.meta).toBe(join(folder, `agent-${subagent.agentId}.meta.json`));
      expect(parseJsonl(readFileSync(subagent.transcript, "utf8")).length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(subagent.meta, "utf8"))).toMatchObject({
        agentType: subagent.agentType,
      });
    }
  });

  it("names the subagents folder only for a session that has subagents", () => {
    expect(fixturePaths("single-agent").subagentsDir).toBeNull();
    expect(fixturePaths("single-agent").subagents).toEqual([]);
    const withSubagents = fixturePaths("two-waves");
    expect(withSubagents.subagentsDir).toBe(
      join(withSubagents.projectDir, withSubagents.sessionId, "subagents"),
    );
    expect(statSync(String(withSubagents.subagentsDir)).isDirectory()).toBe(true);
    expect(withSubagents.subagents).toHaveLength(5);
  });

  it("resolves against another folder that holds a set written with the default seed", () => {
    const dir = makeTempDir();
    writeFixtureTree(dir);
    const paths = fixturePaths("mcp-tools", dir);
    expect(paths.configDir).toBe(join(dir, "config"));
    expect(paths.transcript.startsWith(`${dir}${sep}`)).toBe(true);
    expect(existsSync(paths.transcript)).toBe(true);
    expect(paths.subagents.every((subagent) => existsSync(subagent.meta))).toBe(true);
    expect(readFileSync(paths.transcript)).toEqual(
      readFileSync(fixturePaths("mcp-tools").transcript),
    );
  });
});

describe("demoFixturePaths", () => {
  it("gives the bundled demo session", () => {
    const demo = demoFixturePaths();
    expect(demo).toEqual(fixturePaths(DEMO_SCENARIO));
    expect(demo.subagents).toHaveLength(14);
    expect(existsSync(demo.transcript)).toBe(true);
    const dir = makeTempDir();
    expect(demoFixturePaths(dir).transcript.startsWith(`${dir}${sep}`)).toBe(true);
  });
});
