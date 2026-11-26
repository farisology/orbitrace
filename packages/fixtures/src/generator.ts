/**
 * The pure half of the package: the seeded generator and everything it is made of.
 *
 * Nothing reachable from this module touches the file system, the clock or Math.random, so
 * it can also run in a browser. Import it as `@orbitrace/fixtures/generator`. The package
 * entry adds the paths of the generated files and the code that writes them.
 */
import { INVENTED_LINE_TYPES } from "./lines.js";
import type { Seed } from "./rng.js";
import {
  SCENARIOS,
  SCENARIO_NAMES,
  type ScenarioDefinition,
  type ScenarioName,
} from "./scenarios.js";
import {
  SessionBuilder,
  type BuiltSession,
  type GeneratedFile,
  type GeneratedSubagent,
  type SessionFacts,
} from "./session-builder.js";

export * from "./lines.js";
export * from "./rng.js";
export * from "./scenarios.js";
export * from "./session-builder.js";
export * from "./vocabulary.js";

/** The seed the committed fixtures are generated from. */
export const DEFAULT_SEED = "orbitrace-fixtures-1";

/** Folder, inside the fixtures folder, that is laid out like a Claude Code config folder. */
export const CONFIG_FOLDER = "config";

/** File, inside the fixtures folder, that lists every session and what is true of it. */
export const MANIFEST_FILE = "manifest.json";

/** Bumped when the layout of the manifest changes. */
export const MANIFEST_VERSION = 1;

export interface GenerateOptions {
  /** Default: DEFAULT_SEED. */
  seed?: Seed;
}

export interface GeneratedSession extends BuiltSession {
  name: ScenarioName;
  description: string;
  /** The seed the whole set was generated from. */
  seed: string;
  /** The invented project name. */
  project: string;
}

export interface ManifestSession {
  name: ScenarioName;
  description: string;
  sessionId: string;
  project: string;
  cwd: string;
  /** Paths are relative to the fixtures folder, with forward slashes. */
  transcript: string;
  subagents: { agentId: string; agentType: string; transcript: string; meta: string }[];
  expected: SessionFacts;
}

export interface FixtureManifest {
  generator: "@orbitrace/fixtures";
  manifestVersion: number;
  seed: string;
  /** Golden replay files are added once the replay model builder exists. */
  goldenReplays: "pending";
  sessions: ManifestSession[];
}

function isScenarioName(name: string): name is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(name);
}

/** Look a scenario up by name. Throws on a name that does not exist. */
export function getScenario(name: string): ScenarioDefinition {
  if (!isScenarioName(name)) {
    throw new Error(`unknown scenario "${name}". Known: ${SCENARIO_NAMES.join(", ")}`);
  }
  return SCENARIOS[name];
}

/**
 * Generate one session. The same scenario and seed always give the same bytes, and a
 * scenario's output does not depend on which other scenarios exist.
 */
export function generateSession(
  name: ScenarioName,
  options: GenerateOptions = {},
): GeneratedSession {
  const scenario = getScenario(name);
  const seed = String(options.seed ?? DEFAULT_SEED);
  const session = new SessionBuilder({
    seed: `${seed}/${scenario.name}`,
    project: scenario.project,
    startTime: scenario.startTime,
    model: scenario.model,
    effort: scenario.effort,
    inventedLineTypes: INVENTED_LINE_TYPES,
    ...(scenario.gitBranch === undefined ? {} : { gitBranch: scenario.gitBranch }),
    ...(scenario.entrypoint === undefined ? {} : { entrypoint: scenario.entrypoint }),
  });
  scenario.script(session);
  return {
    name: scenario.name,
    description: scenario.description,
    seed,
    project: scenario.project,
    ...session.build(),
  };
}

/** Generate every scenario, in the order of SCENARIO_NAMES. */
export function generateAll(options: GenerateOptions = {}): GeneratedSession[] {
  return SCENARIO_NAMES.map((name) => generateSession(name, options));
}

function inConfig(path: string): string {
  return `${CONFIG_FOLDER}/${path}`;
}

/** The manifest for a set of sessions generated from one seed. */
export function buildManifest(sessions: readonly GeneratedSession[]): FixtureManifest {
  const seeds = new Set(sessions.map((session) => session.seed));
  if (seeds.size > 1) throw new Error("a manifest covers sessions generated from one seed");
  return {
    generator: "@orbitrace/fixtures",
    manifestVersion: MANIFEST_VERSION,
    seed: sessions[0]?.seed ?? String(DEFAULT_SEED),
    goldenReplays: "pending",
    sessions: sessions.map((session) => ({
      name: session.name,
      description: session.description,
      sessionId: session.sessionId,
      project: session.project,
      cwd: session.cwd,
      transcript: inConfig(session.transcriptPath),
      subagents: session.subagents.map((subagent: GeneratedSubagent) => ({
        agentId: subagent.agentId,
        agentType: subagent.agentType,
        transcript: inConfig(subagent.transcriptPath),
        meta: inConfig(subagent.metaPath),
      })),
      expected: session.expected,
    })),
  };
}

/**
 * Every generated file of the fixtures folder: the manifest, then each session's files
 * under the config folder. Paths are relative to the fixtures folder, with forward slashes.
 */
export function renderFixtureTree(options: GenerateOptions = {}): GeneratedFile[] {
  const sessions = generateAll(options);
  const files: GeneratedFile[] = [
    { path: MANIFEST_FILE, content: `${JSON.stringify(buildManifest(sessions), null, 2)}\n` },
  ];
  for (const session of sessions) {
    for (const file of session.files) {
      files.push({ path: inConfig(file.path), content: file.content });
    }
  }
  return files;
}
