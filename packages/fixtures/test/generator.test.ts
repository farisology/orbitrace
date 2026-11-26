import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index.js";
import * as pure from "../src/generator.js";
import {
  CONFIG_FOLDER,
  DEFAULT_SEED,
  MANIFEST_FILE,
  MANIFEST_VERSION,
  SCENARIOS,
  SCENARIO_NAMES,
  buildManifest,
  generateAll,
  generateSession,
  getScenario,
  renderFixtureTree,
  type FixtureManifest,
  type GeneratedFile,
} from "../src/index.js";
import { parseJsonl } from "./helpers.js";

const SOURCE_DIR = fileURLToPath(new URL("../src/", import.meta.url));
/** The contract package, which the generator half imports. Read here, never written. */
const CORE_SOURCE_DIR = fileURLToPath(new URL("../../core/src/", import.meta.url));

function bytes(files: readonly GeneratedFile[]): string {
  return files.map((file) => `${file.path}\u0000${file.content}`).join("\u0001");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("determinism", () => {
  it("writes byte-identical files for the same seed", () => {
    const first = renderFixtureTree();
    const second = renderFixtureTree();
    expect(second.map((file) => file.path)).toEqual(first.map((file) => file.path));
    for (const [index, file] of first.entries()) {
      expect(Buffer.from(file.content).equals(Buffer.from(second[index]?.content ?? ""))).toBe(
        true,
      );
    }
    expect(bytes(renderFixtureTree({ seed: "another" }))).toBe(
      bytes(renderFixtureTree({ seed: "another" })),
    );
    expect(bytes(renderFixtureTree({ seed: DEFAULT_SEED }))).toBe(bytes(first));
  });

  it("writes other bytes for another seed", () => {
    const first = renderFixtureTree({ seed: "one" });
    const second = renderFixtureTree({ seed: "two" });
    expect(bytes(first)).not.toBe(bytes(second));
    for (const name of SCENARIO_NAMES) {
      const a = generateSession(name, { seed: "one" });
      const b = generateSession(name, { seed: "two" });
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.files[0]?.content).not.toBe(b.files[0]?.content);
      // The seed changes the values, not what the scenario is about.
      expect(b.subagents.map((item) => item.agentType)).toEqual(
        a.subagents.map((item) => item.agentType),
      );
      expect(b.cwd).toBe(a.cwd);
    }
  });

  it("treats a number and the text that prints the same as one seed", () => {
    expect(bytes(renderFixtureTree({ seed: 42 }))).toBe(bytes(renderFixtureTree({ seed: "42" })));
    expect(generateSession("single-agent", { seed: 42 }).seed).toBe("42");
  });

  it("generates a scenario the same way alone and as part of the whole set", () => {
    const all = generateAll({ seed: "set" });
    expect(all.map((session) => session.name)).toEqual([...SCENARIO_NAMES]);
    for (const session of all) {
      expect(generateSession(session.name, { seed: "set" })).toEqual(session);
    }
  });

  it("does not read the clock or Math.random", () => {
    const before = bytes(renderFixtureTree());
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random was called");
    });
    vi.useFakeTimers({ now: new Date("2031-07-01T00:00:00.000Z") });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now was called");
    });
    const during = bytes(renderFixtureTree());
    vi.restoreAllMocks();
    vi.setSystemTime(new Date("1999-12-31T23:59:59.000Z"));
    const later = bytes(renderFixtureTree());
    expect(during).toBe(before);
    expect(later).toBe(before);
  });

  it("stamps every line from the scenario's start time, not from today", () => {
    for (const session of generateAll()) {
      const start = Date.parse(SCENARIOS[session.name].startTime);
      const stamps = session.files
        .filter((file) => file.path.endsWith(".jsonl"))
        .flatMap((file) => parseJsonl(file.content))
        .map((line) => line.timestamp)
        .filter((value): value is string => typeof value === "string")
        .map((value) => Date.parse(value));
      expect(Math.min(...stamps)).toBeGreaterThanOrEqual(start);
      expect(Math.max(...stamps)).toBeLessThan(start + 2 * 60 * 60 * 1000);
    }
  });
});

describe("source of the generator", () => {
  const sources = readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(`${SOURCE_DIR}${name}`, "utf8") }));
  const NODE_ONLY = ["cli.ts", "index.ts", "paths.ts", "write.ts"];

  it("never calls Math.random, Date.now or a Date without a value", () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
    const offenders = sources
      .filter(({ text }) =>
        /Math\.random\s*\(|Date\.now\s*\(|new Date\(\s*\)|performance\.now/.test(text),
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("keeps the generator half free of Node imports, so it can run in a browser", () => {
    const withNodeImports = sources
      .filter(({ text }) => /from\s+"node:|require\(|\bprocess\.|\bBuffer\b/.test(text))
      .map(({ name }) => name);
    expect(withNodeImports.filter((name) => !NODE_ONLY.includes(name))).toEqual([]);
    const generatorImports = sources
      .filter(({ name }) => !NODE_ONLY.includes(name))
      .flatMap(({ text }) =>
        [...text.matchAll(/from\s+"(\.\/[^"]+)\.js"/g)].map((match) => match[1]),
      );
    const reachesNode = generatorImports.filter((path) =>
      NODE_ONLY.includes(`${String(path).slice(2)}.ts`),
    );
    expect(reachesNode).toEqual([]);
  });

  it("imports one other package from the generator half, the contract, which has no Node imports", () => {
    const bare = sources
      .filter(({ name }) => !NODE_ONLY.includes(name))
      .flatMap(({ text }) => [...text.matchAll(/from\s+"([^."][^"]*)"/g)].map((match) => match[1]));
    expect([...new Set(bare)]).toEqual(["@orbitrace/core"]);

    // Only the files the main entry of core reaches count. Node-only code behind the
    // `@orbitrace/core/node` subpath is never loaded by the generator half.
    const coreSources: string[] = [];
    const pending = ["index.ts"];
    while (pending.length > 0) {
      const name = pending.pop()!;
      if (coreSources.includes(name)) continue;
      coreSources.push(name);
      const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
      const text = readFileSync(`${CORE_SOURCE_DIR}${name}`, "utf8");
      for (const match of text.matchAll(/from\s+"(\.\.?\/[^"]+)\.js"/g)) {
        const parts = `${dir}${match[1]!}.ts`.split("/");
        const resolved: string[] = [];
        for (const part of parts) {
          if (part === "..") resolved.pop();
          else if (part !== ".") resolved.push(part);
        }
        pending.push(resolved.join("/"));
      }
    }
    expect(coreSources.length).toBeGreaterThan(1);
    const coreWithNode = coreSources.filter((name) =>
      /from\s+"node:|import\s*\(?\s*"node:|\brequire\(/.test(
        readFileSync(`${CORE_SOURCE_DIR}${name}`, "utf8"),
      ),
    );
    // The generator half loads the entry of @orbitrace/core for two constants. If core gains
    // a Node import, give core a Node-free entry for its model and import that here, or stop
    // saying that @orbitrace/fixtures/generator runs in a browser.
    expect(coreWithNode, "core sources with a Node import").toEqual([]);
  });
});

describe("package entry", () => {
  it("exports the generator, the paths and the writer", () => {
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining([
        "generateSession",
        "generateAll",
        "renderFixtureTree",
        "buildManifest",
        "getScenario",
        "SCENARIOS",
        "SCENARIO_NAMES",
        "DEMO_SCENARIO",
        "DEFAULT_SEED",
        "SessionBuilder",
        "createRng",
        "FIXTURES_DIR",
        "FIXTURE_CONFIG_DIR",
        "FIXTURE_MANIFEST_PATH",
        "fixturePaths",
        "demoFixturePaths",
        "writeFixtureTree",
        "checkFixtureTree",
        "isFixtureTreeCurrent",
      ]),
    );
  });

  it("exports the same generator from the entry and from the generator module", () => {
    for (const [name, value] of Object.entries(pure)) {
      expect((entry as Record<string, unknown>)[name]).toBe(value);
    }
    expect("FIXTURES_DIR" in pure).toBe(false);
    expect("writeFixtureTree" in pure).toBe(false);
  });
});

describe("getScenario", () => {
  it("returns the definition of a known scenario", () => {
    expect(getScenario("demo")).toBe(SCENARIOS.demo);
    expect(getScenario("idle-gap").name).toBe("idle-gap");
  });

  it("throws on a name that does not exist, and lists the known names", () => {
    expect(() => getScenario("nope")).toThrow('unknown scenario "nope". Known: single-agent');
    expect(() => getScenario("toString")).toThrow("unknown scenario");
  });
});

describe("generateSession", () => {
  it("carries the scenario, the seed and the project with the built session", () => {
    const session = generateSession("two-waves");
    expect(session).toMatchObject({
      name: "two-waves",
      description: SCENARIOS["two-waves"].description,
      seed: DEFAULT_SEED,
      project: "kite-workshop",
      cwd: "/workspace/kite-workshop",
      projectDir: "-workspace-kite-workshop",
    });
    expect(session.files).toHaveLength(11);
    expect(session.expected.agents).toHaveLength(6);
  });

  it("gives two sessions of one project different ids and the same project folder", () => {
    const a = generateSession("single-agent");
    const b = generateSession("split-reply");
    expect(a.projectDir).toBe(b.projectDir);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe("buildManifest", () => {
  it("lists every session with its files and facts, with paths under the config folder", () => {
    const sessions = generateAll();
    const manifest = buildManifest(sessions);
    expect(manifest).toMatchObject({
      generator: "@orbitrace/fixtures",
      manifestVersion: MANIFEST_VERSION,
      seed: DEFAULT_SEED,
      goldenReplays: "pending",
    });
    expect(manifest.sessions.map((session) => session.name)).toEqual([...SCENARIO_NAMES]);
    for (const [index, listed] of manifest.sessions.entries()) {
      const session = sessions[index] as (typeof sessions)[number];
      expect(listed).toEqual({
        name: session.name,
        description: session.description,
        sessionId: session.sessionId,
        project: session.project,
        cwd: session.cwd,
        transcript: `${CONFIG_FOLDER}/${session.transcriptPath}`,
        subagents: session.subagents.map((subagent) => ({
          agentId: subagent.agentId,
          agentType: subagent.agentType,
          transcript: `${CONFIG_FOLDER}/${subagent.transcriptPath}`,
          meta: `${CONFIG_FOLDER}/${subagent.metaPath}`,
        })),
        expected: session.expected,
      });
    }
  });

  it("refuses sessions generated from different seeds, and accepts an empty list", () => {
    const mixed = [
      generateSession("single-agent", { seed: "a" }),
      generateSession("idle-gap", { seed: "b" }),
    ];
    expect(() => buildManifest(mixed)).toThrow("one seed");
    expect(buildManifest([])).toMatchObject({ seed: DEFAULT_SEED, sessions: [] });
    expect(buildManifest([generateSession("idle-gap", { seed: "b" })]).seed).toBe("b");
  });
});

describe("renderFixtureTree", () => {
  const files = renderFixtureTree();

  it("writes the manifest first, then every file of every session under the config folder", () => {
    const sessions = generateAll();
    expect(files[0]?.path).toBe(MANIFEST_FILE);
    expect(JSON.parse(files[0]?.content ?? "") as FixtureManifest).toEqual(buildManifest(sessions));
    expect(files[0]?.content.endsWith("}\n")).toBe(true);
    expect(files.slice(1).map((file) => file.path)).toEqual(
      sessions.flatMap((session) => session.files.map((file) => `${CONFIG_FOLDER}/${file.path}`)),
    );
    expect(files.slice(1).map((file) => file.content)).toEqual(
      sessions.flatMap((session) => session.files.map((file) => file.content)),
    );
  });

  it("writes each path once, as a clean relative path", () => {
    const paths = files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((path) => path.startsWith("/") || path.includes(".."))).toEqual([]);
    expect(paths.filter((path) => path.includes("\\"))).toEqual([]);
    const kinds = new Set(
      paths.map((path) => path.replace(/^.*?(\.meta\.json|\.jsonl|\.json)$/, "$1")),
    );
    expect(kinds).toEqual(new Set([".json", ".jsonl", ".meta.json"]));
  });

  it("puts transcripts only where the repository allows .jsonl files", () => {
    // The root .gitignore ignores *.jsonl except under fixtures/, and the tree is written
    // into fixtures/, so every transcript path must stay inside the tree.
    const transcripts = files.filter((file) => file.path.endsWith(".jsonl"));
    expect(transcripts.length).toBeGreaterThan(SCENARIO_NAMES.length);
    expect(transcripts.every((file) => file.path.startsWith(`${CONFIG_FOLDER}/projects/`))).toBe(
      true,
    );
  });
});
