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
  EXTRA_SCENARIOS,
  EXTRA_SCENARIO_NAMES,
  SCENARIOS,
  SCENARIO_NAMES,
  type ExtraScenarioDefinition,
  type ExtraScenarioName,
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

/**
 * Folder, inside the fixtures folder, that holds the golden replay files. The generator does
 * not write it: the files are the output of the replay pipeline of `@orbitrace/core` over
 * the generated transcripts (see `goldens.ts`). The generator only knows their names.
 */
export const REPLAYS_FOLDER = "replays";

/** Ending of every replay file. */
export const REPLAY_FILE_SUFFIX = ".replay.json";

/**
 * Replay files in the replays folder that are written by hand and are not goldens. Paths are
 * relative to the fixtures folder, with forward slashes.
 */
export const HAND_WRITTEN_REPLAYS: readonly string[] = [
  `${REPLAYS_FOLDER}/minimal${REPLAY_FILE_SUFFIX}`,
];

/**
 * Bumped when the layout of the manifest changes. 2: `goldenReplays` lists the golden replay
 * files and every session names its own (`goldenReplay`); 1 said `"pending"`.
 */
export const MANIFEST_VERSION = 2;

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
  /** The golden replay of this session: what the replay pipeline makes of its transcripts. */
  goldenReplay: string;
  expected: SessionFacts;
}

export interface FixtureManifest {
  generator: "@orbitrace/fixtures";
  manifestVersion: number;
  seed: string;
  /** The golden replay file of every session, in session order. */
  goldenReplays: string[];
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

/** Run a scenario's script with a seed of its own, and build the session. */
function runScenario(
  scenario: ScenarioDefinition | ExtraScenarioDefinition,
  seed: string,
): BuiltSession {
  const session = new SessionBuilder({
    seed: `${seed}/${scenario.name}`,
    project: scenario.project,
    startTime: scenario.startTime,
    model: scenario.model,
    effort: scenario.effort,
    inventedLineTypes: INVENTED_LINE_TYPES,
    ...(scenario.gitBranch === undefined ? {} : { gitBranch: scenario.gitBranch }),
    ...(scenario.entrypoint === undefined ? {} : { entrypoint: scenario.entrypoint }),
    ...(scenario.cacheWrites === undefined ? {} : { cacheWrites: scenario.cacheWrites }),
  });
  scenario.script(session);
  return session.build();
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
  return {
    name: scenario.name,
    description: scenario.description,
    seed,
    project: scenario.project,
    ...runScenario(scenario, seed),
  };
}

/** #191. A session of an on-demand scenario (`EXTRA_SCENARIO_NAMES`). */
export interface GeneratedExtraSession extends Omit<GeneratedSession, "name"> {
  name: ExtraScenarioName;
}

function isExtraScenarioName(name: string): name is ExtraScenarioName {
  return (EXTRA_SCENARIO_NAMES as readonly string[]).includes(name);
}

/**
 * #191. Generate a session of an on-demand scenario, the same way as `generateSession`. It is
 * never part of `generateAll`, the manifest or the committed fixtures; write it with
 * `writeGeneratedSession` where a test needs it on disk. Throws on a name that does not exist.
 */
export function generateExtraSession(
  name: string,
  options: GenerateOptions = {},
): GeneratedExtraSession {
  if (!isExtraScenarioName(name)) {
    throw new Error(`unknown extra scenario "${name}". Known: ${EXTRA_SCENARIO_NAMES.join(", ")}`);
  }
  const scenario = EXTRA_SCENARIOS[name];
  const seed = String(options.seed ?? DEFAULT_SEED);
  return {
    name: scenario.name,
    description: scenario.description,
    seed,
    project: scenario.project,
    ...runScenario(scenario, seed),
  };
}

/** Generate every scenario, in the order of SCENARIO_NAMES. */
export function generateAll(options: GenerateOptions = {}): GeneratedSession[] {
  return SCENARIO_NAMES.map((name) => generateSession(name, options));
}

function inConfig(path: string): string {
  return `${CONFIG_FOLDER}/${path}`;
}

/**
 * The golden replay file of a scenario, relative to the fixtures folder, with forward
 * slashes: `replays/<scenario>.replay.json`. The name is the scenario's, never a session id
 * or a project name.
 */
export function goldenReplayFile(name: ScenarioName): string {
  return `${REPLAYS_FOLDER}/${name}${REPLAY_FILE_SUFFIX}`;
}

/** The manifest for a set of sessions generated from one seed. */
export function buildManifest(sessions: readonly GeneratedSession[]): FixtureManifest {
  const seeds = new Set(sessions.map((session) => session.seed));
  if (seeds.size > 1) throw new Error("a manifest covers sessions generated from one seed");
  return {
    generator: "@orbitrace/fixtures",
    manifestVersion: MANIFEST_VERSION,
    seed: sessions[0]?.seed ?? String(DEFAULT_SEED),
    goldenReplays: sessions.map((session) => goldenReplayFile(session.name)),
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
      goldenReplay: goldenReplayFile(session.name),
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
