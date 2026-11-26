/**
 * Where the generated fixture files live in the repository, as absolute paths.
 *
 * The files are committed under `fixtures/` at the repository root. This package is private
 * and is only ever used from inside the repository, so the paths are resolved from the
 * location of this module: `src/` and `dist/` are both three levels below the root.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FOLDER,
  DEMO_SCENARIO,
  MANIFEST_FILE,
  REPLAYS_FOLDER,
  generateSession,
  goldenReplayFile,
  type GeneratedSession,
  type ScenarioName,
} from "./generator.js";

/** The fixtures folder at the repository root. */
export const FIXTURES_DIR = resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));

/**
 * A folder laid out like a Claude Code config folder: `projects/<project>/<session>.jsonl`.
 * Point a source resolver at it the way CLAUDE_CONFIG_DIR would.
 */
export const FIXTURE_CONFIG_DIR = join(FIXTURES_DIR, CONFIG_FOLDER);

/** The manifest: every session, its files and what is true of it. */
export const FIXTURE_MANIFEST_PATH = join(FIXTURES_DIR, MANIFEST_FILE);

/** The folder that holds the golden replay files, and the hand-written example beside them. */
export const GOLDEN_REPLAYS_DIR = join(FIXTURES_DIR, REPLAYS_FOLDER);

/**
 * The absolute path of the golden replay of one scenario. `fixturesDir` is for a set written
 * somewhere else.
 */
export function goldenReplayPath(name: ScenarioName, fixturesDir: string = FIXTURES_DIR): string {
  return join(fixturesDir, ...goldenReplayFile(name).split("/"));
}

/**
 * The absolute path of the golden replay of the bundled demo session:
 * `fixtures/replays/demo.replay.json`. A replay v1 file, safe to ship: structure and timing
 * only. Check what is read from it with `validateReplay` from `@orbitrace/core` before use.
 */
export const DEMO_GOLDEN_REPLAY_PATH = goldenReplayPath(DEMO_SCENARIO);

export interface FixtureSubagentPaths {
  agentId: string;
  agentType: string;
  /** Absolute path of `agent-<agentId>.jsonl`. */
  transcript: string;
  /** Absolute path of `agent-<agentId>.meta.json`. */
  meta: string;
}

export interface FixturePaths {
  name: ScenarioName;
  sessionId: string;
  /** Absolute path of the synthetic config folder. */
  configDir: string;
  /** Absolute path of the project folder that holds the session. */
  projectDir: string;
  /** Absolute path of the main transcript. */
  transcript: string;
  /** Absolute path of the folder with the subagent files, or null without subagents. */
  subagentsDir: string | null;
  subagents: FixtureSubagentPaths[];
}

const sessions = new Map<ScenarioName, GeneratedSession>();

function committedSession(name: ScenarioName): GeneratedSession {
  let session = sessions.get(name);
  if (session === undefined) {
    session = generateSession(name);
    sessions.set(name, session);
  }
  return session;
}

/**
 * The absolute paths of one committed fixture. `fixturesDir` is for a set written somewhere
 * else with writeFixtureTree and the default seed.
 */
export function fixturePaths(name: ScenarioName, fixturesDir: string = FIXTURES_DIR): FixturePaths {
  const session = committedSession(name);
  const configDir = join(fixturesDir, CONFIG_FOLDER);
  const projectDir = join(configDir, "projects", session.projectDir);
  const sessionDir = join(projectDir, session.sessionId);
  return {
    name,
    sessionId: session.sessionId,
    configDir,
    projectDir,
    transcript: join(configDir, ...session.transcriptPath.split("/")),
    subagentsDir: session.subagents.length > 0 ? join(sessionDir, "subagents") : null,
    subagents: session.subagents.map((subagent) => ({
      agentId: subagent.agentId,
      agentType: subagent.agentType,
      transcript: join(configDir, ...subagent.transcriptPath.split("/")),
      meta: join(configDir, ...subagent.metaPath.split("/")),
    })),
  };
}

/** The absolute paths of the bundled demo session. */
export function demoFixturePaths(fixturesDir: string = FIXTURES_DIR): FixturePaths {
  return fixturePaths(DEMO_SCENARIO, fixturesDir);
}
