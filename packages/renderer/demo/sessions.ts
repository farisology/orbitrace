/**
 * Replays for the demo page, the benchmarks and the renderer's tests, made the way real
 * sessions are made (#77): a synthetic transcript from the seeded generator in
 * `@orbitrace/fixtures`, through core's real `parseSession` and `buildReplay`. Nothing here
 * builds a replay by hand, so the renderer is measured and shown on what the builder produces.
 *
 * Every value is invented by the generator: agent types, tool calls, timings, token counts.
 * Browser-safe: the generator entry and core's main entry import no Node module, so the demo
 * page runs the same pipeline in the browser.
 */

import {
  buildReplay,
  parseSession,
  type BuildReplayOptions,
  type KnownEffortLevel,
  type ParsedSession,
  type ReplayModel,
  type SessionInput,
} from "@orbitrace/core";
import {
  DEMO_SCENARIO,
  MODELS,
  SessionBuilder,
  generateSession,
  type AgentWriter,
  type BuiltSession,
  type SubagentSpec,
  type ToolSpec,
} from "@orbitrace/fixtures/generator";

/** A generated session as the parser's input: each file's text split into lines. */
export function sessionInput(session: BuiltSession): SessionInput {
  const lines = (path: string): string[] => {
    const file = session.files.find((candidate) => candidate.path === path);
    if (file === undefined) throw new Error(`no generated file at ${path}`);
    const text = file.content.endsWith("\n") ? file.content.slice(0, -1) : file.content;
    return text === "" ? [] : text.split("\n");
  };
  return {
    main: lines(session.transcriptPath),
    subagents: session.subagents.map((subagent) => ({
      agentId: subagent.agentId,
      meta: subagent.meta,
      lines: lines(subagent.transcriptPath),
    })),
  };
}

/** Parse a generated session with core's parser. */
export function parseGenerated(session: BuiltSession): Promise<ParsedSession> {
  return parseSession(sessionInput(session));
}

/** A generated session through the whole pipeline: `parseSession`, then `buildReplay`. */
export async function replayOf(
  session: BuiltSession,
  options?: BuildReplayOptions,
): Promise<ReplayModel> {
  return buildReplay(await parseGenerated(session), options);
}

/** The bundled demo session (`demo` scenario: 15 agents in 4 waves), as a generated session. */
export function demoSession(): BuiltSession {
  return generateSession(DEMO_SCENARIO);
}

/** The demo session's replay. Equal to fixtures/replays/demo.replay.json. */
export function demoReplay(): Promise<ReplayModel> {
  return replayOf(demoSession());
}

export interface ScaledSessionOptions {
  /** Seed for the generator. The same options always give the same session. */
  readonly seed?: string;
  /** Subagents per wave. Default `DEFAULT_AGENTS_PER_WAVE`. */
  readonly agentsPerWave?: number;
  /** Tool rounds per subagent, as `[min, max]`. Default `[3, 8]`. */
  readonly rounds?: readonly [number, number];
  /** Tool rounds of the main agent between two waves. Default 2. */
  readonly mainRounds?: number;
}

/** Subagents per wave in a scaled session. */
export const DEFAULT_AGENTS_PER_WAVE = 25;

/**
 * Seconds of the shell command the main agent runs between two waves. More than the 60 s wave
 * gap of `buildReplay`, so each spawn opens a new orbit.
 */
const WAVE_BREAK_SECONDS = 75;

const SUBAGENT_TYPES: readonly { type: string; model: string; effort: KnownEffortLevel }[] = [
  { type: "Explore", model: MODELS.haiku, effort: "low" },
  { type: "Plan", model: MODELS.opus, effort: "high" },
  { type: "lantern-builder", model: MODELS.sonnet, effort: "medium" },
  { type: "kite-rigger", model: MODELS.opus, effort: "xhigh" },
  { type: "code-reviewer", model: MODELS.opus, effort: "max" },
  { type: "docs-scribe", model: MODELS.haiku, effort: "medium" },
  { type: "general-purpose", model: MODELS.fable, effort: "high" },
  { type: "schema-cartographer", model: MODELS.sonnet, effort: "high" },
];

function pickTool(agent: AgentWriter): ToolSpec {
  const rng = agent.rng;
  const outcome = rng.chance(0.06) ? ({ outcome: "error" } as const) : {};
  switch (rng.int(0, 9)) {
    case 0:
    case 1:
    case 2:
      return agent.tools.read(outcome);
    case 3:
    case 4:
      return agent.tools.grep(outcome);
    case 5:
      return agent.tools.edit(outcome);
    case 6:
      return agent.tools.write(outcome);
    case 7:
      return agent.tools.mcp("tide-almanac", "lookup_tide", outcome);
    default:
      return agent.tools.bash(outcome);
  }
}

function rounds(agent: AgentWriter, count: number): void {
  for (let round = 0; round < count; round += 1) {
    const batch = agent.rng.pick([1, 1, 2, 2, 3]);
    const tools: ToolSpec[] = [];
    for (let k = 0; k < batch; k += 1) tools.push(pickTool(agent));
    agent.use(tools, { thinking: agent.rng.chance(0.4), text: agent.rng.chance(0.3) });
  }
  agent.say();
}

/**
 * A synthetic session with `agents` agents in all: the main agent and `agents - 1` subagents
 * spawned by the main agent in waves of `agentsPerWave`, a long shell command between waves.
 * For the benchmarks at 15, 100 and 500 agents and for the 50 MB transcript.
 */
export function scaledSession(agents: number, options: ScaledSessionOptions = {}): BuiltSession {
  if (!Number.isInteger(agents) || agents < 1) throw new RangeError("agents must be 1 or more");
  const perWave = Math.max(1, options.agentsPerWave ?? DEFAULT_AGENTS_PER_WAVE);
  const [minRounds, maxRounds] = options.rounds ?? [3, 8];
  const mainRounds = options.mainRounds ?? 2;
  const session = new SessionBuilder({
    seed: options.seed ?? `orbitrace-scaled/${agents}`,
    project: "scaled-orrery",
    startTime: "2026-04-01T08:00:00.000Z",
    model: MODELS.opus,
    effort: "high",
  });
  const main = session.main;
  session.open();
  main.prompt();
  let spawned = 0;
  let wave = 0;
  while (spawned < agents - 1) {
    if (wave > 0) {
      main.use(main.tools.bash({ durationMs: WAVE_BREAK_SECONDS * 1000 }), { text: true });
    }
    for (let k = 0; k < mainRounds; k += 1) main.use(pickTool(main), { thinking: true });
    const count = Math.min(perWave, agents - 1 - spawned);
    const children: SubagentSpec[] = [];
    for (let k = 0; k < count; k += 1) {
      const kind = SUBAGENT_TYPES[(spawned + k) % SUBAGENT_TYPES.length]!;
      const own = main.rng.int(minRounds, maxRounds);
      children.push({
        agentType: kind.type,
        model: kind.model,
        effort: kind.effort,
        script: (agent) => rounds(agent, own),
      });
    }
    main.spawn(children, { text: true });
    spawned += count;
    wave += 1;
  }
  rounds(main, mainRounds);
  session.close();
  return session.build();
}

/** The replay of `scaledSession(agents, options)`. */
export function scaledReplay(agents: number, options?: ScaledSessionOptions): Promise<ReplayModel> {
  return replayOf(scaledSession(agents, options));
}

/** Total bytes of a generated session's files, as they would be written to disk. */
export function sessionBytes(session: BuiltSession): number {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const file of session.files) bytes += encoder.encode(file.content).byteLength;
  return bytes;
}

/**
 * The earliest time in a parsed session, Unix epoch milliseconds: time 0 of its replay. The demo
 * adds real seconds to it to ask `buildReplay` for a live snapshot at a replay time.
 */
export function sessionStartMs(parsed: ParsedSession): number {
  let first = Infinity;
  for (const run of [parsed.main, ...parsed.subagents]) {
    if (run.startedAt !== null && run.startedAt < first) first = run.startedAt;
  }
  return Number.isFinite(first) ? first : 0;
}
