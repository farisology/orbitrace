/**
 * What must hold for every fixture, whatever the scenario and the seed: valid JSON lines with
 * the keys a reader relies on, tool results that pair with tool calls, the subagent folder
 * layout, and facts that match what can be counted from the lines.
 *
 * Each check collects problems as text and expects the list to be empty, so a failure says
 * which agent and which line broke the rule.
 */
import { describe, expect, it } from "vitest";
import {
  COMMON_LINE_KEYS,
  CONVERSATION_LINE_TYPES,
  DEFAULT_SEED,
  KNOWN_EFFORT_LEVELS,
  MAIN_AGENT_ID,
  SCENARIO_NAMES,
  SUBAGENT_META_KEYS,
  SYNTHETIC_MARKER,
  USAGE_KEYS,
  generateSession,
  type AgentFacts,
  type GeneratedSession,
} from "../src/index.js";
import {
  allStrings,
  allTranscripts,
  contentBlocks,
  countWaves,
  countedFacts,
  idleGaps,
  isObject,
  parseJsonl,
  readSession,
  subagentStartTimes,
  summarise,
  toolResultBlocks,
  toolUseBlocks,
  type JsonObject,
  type SessionTranscripts,
} from "./helpers.js";

const SEEDS = [DEFAULT_SEED, "0", "1", "7", "orbitrace-alt", "a longer seed, with spaces"];
const CASES = SEEDS.flatMap((seed) => SCENARIO_NAMES.map((name) => ({ name, seed })));

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KNOWN_BLOCK_TYPES = ["text", "thinking", "tool_use"];

function isConversationLine(line: JsonObject): boolean {
  return (CONVERSATION_LINE_TYPES as readonly string[]).includes(String(line.type));
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function serialisationProblems(session: GeneratedSession): string[] {
  const problems: string[] = [];
  for (const file of session.files) {
    if (!file.content.endsWith("\n")) problems.push(`${file.path} does not end with a newline`);
    if (!file.path.endsWith(".jsonl")) continue;
    file.content
      .slice(0, -1)
      .split("\n")
      .forEach((text, index) => {
        const at = `${file.path}:${index + 1}`;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          problems.push(`${at} is not valid JSON`);
          return;
        }
        if (!isObject(value)) problems.push(`${at} is not a JSON object`);
        else if (typeof value.type !== "string" || value.type === "") {
          problems.push(`${at} has no type`);
        }
        // One object per line, written the way JSON.stringify writes it: no stray spaces,
        // no line breaks inside a line.
        if (JSON.stringify(value) !== text) problems.push(`${at} is not in canonical form`);
      });
  }
  return problems;
}

function commonKeyProblems(
  session: GeneratedSession,
  agentId: string,
  lines: readonly JsonObject[],
): string[] {
  const problems: string[] = [];
  const isMain = agentId === MAIN_AGENT_ID;
  lines.forEach((line, index) => {
    if (!isConversationLine(line)) return;
    const at = `${agentId}:${index + 1}`;
    for (const key of COMMON_LINE_KEYS) {
      if (!(key in line)) problems.push(`${at} lacks ${key}`);
    }
    if (typeof line.uuid !== "string" || !UUID.test(line.uuid)) problems.push(`${at} uuid`);
    if (line.parentUuid !== null && typeof line.parentUuid !== "string") {
      problems.push(`${at} parentUuid`);
    }
    if (typeof line.timestamp !== "string" || !ISO_UTC.test(line.timestamp)) {
      problems.push(`${at} timestamp is not ISO 8601 UTC`);
    }
    if (line.sessionId !== session.sessionId) problems.push(`${at} sessionId`);
    if (line.cwd !== session.cwd) problems.push(`${at} cwd`);
    if (typeof line.gitBranch !== "string" || line.gitBranch === "") {
      problems.push(`${at} gitBranch`);
    }
    if (typeof line.version !== "string" || !/^2\.1\.\d+$/.test(line.version)) {
      problems.push(`${at} version`);
    }
    if (line.entrypoint !== "cli" && line.entrypoint !== "claude-vscode") {
      problems.push(`${at} entrypoint`);
    }
    if (line.isSidechain !== !isMain) problems.push(`${at} isSidechain`);
    if (isMain && "agentId" in line) problems.push(`${at} has an agentId in the main transcript`);
    if (!isMain && line.agentId !== agentId) problems.push(`${at} agentId`);
  });
  return problems;
}

function chainProblems(transcripts: SessionTranscripts): string[] {
  const problems: string[] = [];
  const everyUuid = new Set<string>();
  for (const [agentId, lines] of allTranscripts(transcripts)) {
    const seen = new Set<string>();
    let previousTime = Number.NEGATIVE_INFINITY;
    lines.forEach((line, index) => {
      const at = `${agentId}:${index + 1}`;
      if (typeof line.timestamp === "string") {
        const time = Date.parse(line.timestamp);
        if (Number.isNaN(time)) problems.push(`${at} timestamp does not parse`);
        if (time < previousTime) problems.push(`${at} is stamped before the line above it`);
        previousTime = time;
      }
      if (typeof line.uuid !== "string") return;
      if (everyUuid.has(line.uuid)) problems.push(`${at} repeats a uuid`);
      if (line.parentUuid === null && seen.size > 0) {
        problems.push(`${at} has no parent but is not the first line of the chain`);
      }
      if (typeof line.parentUuid === "string" && !seen.has(line.parentUuid)) {
        problems.push(`${at} names a parent that is not an earlier line of the same file`);
      }
      everyUuid.add(line.uuid);
      seen.add(line.uuid);
    });
  }
  return problems;
}

function assistantProblems(agent: AgentFacts, lines: readonly JsonObject[]): string[] {
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.type !== "assistant") return;
    const at = `${agent.id}:${index + 1}`;
    const message = line.message;
    if (!isObject(message)) {
      problems.push(`${at} has no message`);
      return;
    }
    if (typeof message.id !== "string" || !message.id.startsWith("msg_")) {
      problems.push(`${at} message.id`);
    }
    if (message.role !== "assistant") problems.push(`${at} message.role`);
    if (message.model !== agent.model) problems.push(`${at} message.model`);
    if (typeof line.requestId !== "string") problems.push(`${at} requestId`);

    const usage = message.usage;
    if (!isObject(usage)) problems.push(`${at} has no usage`);
    else {
      for (const key of USAGE_KEYS) {
        if (!isCount(usage[key])) problems.push(`${at} usage.${key}`);
      }
    }

    // Claude Code writes one content block per assistant line.
    const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    if (blocks.length !== 1) problems.push(`${at} does not hold exactly one content block`);
    for (const block of blocks) {
      if (typeof block.type !== "string") problems.push(`${at} block type`);
      if (block.type === "text" && typeof block.text !== "string") problems.push(`${at} text`);
      if (block.type === "thinking" && typeof block.thinking !== "string") {
        problems.push(`${at} thinking`);
      }
      if (block.type === "tool_use") {
        if (typeof block.id !== "string" || !block.id.startsWith("toolu_")) {
          problems.push(`${at} tool_use.id`);
        }
        if (typeof block.name !== "string" || block.name === "") {
          problems.push(`${at} tool_use.name`);
        }
        if (!isObject(block.input)) problems.push(`${at} tool_use.input`);
      }
    }

    // The effort keys are optional on real lines. When present they hold the agent's effort.
    if ("effort" in line) {
      if (line.effort !== agent.effort) problems.push(`${at} effort`);
      if (!(KNOWN_EFFORT_LEVELS as readonly unknown[]).includes(line.effort)) {
        problems.push(`${at} effort is not a known level`);
      }
      if (!("perTurnEffort" in line)) problems.push(`${at} has effort but no perTurnEffort`);
    }
    if ("perTurnEffort" in line && line.perTurnEffort !== null) {
      if (line.perTurnEffort !== agent.effort) problems.push(`${at} perTurnEffort`);
    }
  });
  return problems;
}

function userProblems(agentId: string, lines: readonly JsonObject[]): string[] {
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.type !== "user") return;
    const at = `${agentId}:${index + 1}`;
    const message = line.message;
    if (!isObject(message)) {
      problems.push(`${at} has no message`);
      return;
    }
    if (message.role !== "user") problems.push(`${at} message.role`);
    const content = message.content;
    if (typeof content !== "string" && !Array.isArray(content)) {
      problems.push(`${at} content is neither a string nor a list`);
    }
    for (const block of contentBlocks(line)) {
      if (block.type !== "tool_result") {
        problems.push(`${at} holds a block that is not a tool_result`);
        continue;
      }
      if (typeof block.tool_use_id !== "string") problems.push(`${at} tool_use_id`);
      if ("is_error" in block && typeof block.is_error !== "boolean") {
        problems.push(`${at} is_error is not a boolean`);
      }
      if (typeof block.content !== "string" && !Array.isArray(block.content)) {
        problems.push(`${at} tool_result content`);
      }
      if (typeof line.sourceToolAssistantUUID !== "string") {
        problems.push(`${at} sourceToolAssistantUUID`);
      }
    }
  });
  return problems;
}

function pairingProblems(agentId: string, lines: readonly JsonObject[]): string[] {
  const problems: string[] = [];
  const uses = toolUseBlocks(lines);
  const answered = new Set<string>();
  for (const result of toolResultBlocks(lines)) {
    const at = `${agentId}:${result.lineIndex + 1}`;
    const use = uses.get(result.toolUseId);
    if (use === undefined) {
      problems.push(`${at} answers a tool call that is not in this transcript`);
      continue;
    }
    if (use.lineIndex >= result.lineIndex) problems.push(`${at} comes before its tool call`);
    if (!(result.time > use.time)) problems.push(`${at} is not stamped after its tool call`);
    if (answered.has(result.toolUseId)) problems.push(`${at} answers a call a second time`);
    answered.add(result.toolUseId);
    const callLine = lines[use.lineIndex] as JsonObject;
    if (result.line.sourceToolAssistantUUID !== callLine.uuid) {
      problems.push(`${at} does not name the line of its tool call`);
    }
  }
  return problems;
}

function textProblems(session: GeneratedSession, transcripts: SessionTranscripts): string[] {
  const problems: string[] = [];
  const marked = (text: unknown): boolean =>
    typeof text === "string" && text.startsWith(`${SYNTHETIC_MARKER} `);
  for (const [agentId, lines] of allTranscripts(transcripts)) {
    lines.forEach((line, index) => {
      const at = `${agentId}:${index + 1}`;
      const message = line.message;
      if (isObject(message) && typeof message.content === "string" && !marked(message.content)) {
        problems.push(`${at} prompt is not marked synthetic`);
      }
      for (const block of contentBlocks(line)) {
        if (block.type === "text" && !marked(block.text)) problems.push(`${at} text`);
        if (block.type === "thinking" && !marked(block.thinking)) problems.push(`${at} thinking`);
        if (block.type === "tool_result") {
          const texts =
            typeof block.content === "string"
              ? [block.content]
              : (block.content as unknown[]).map((item) => (isObject(item) ? item.text : item));
          if (!texts.every(marked)) problems.push(`${at} tool result is not marked synthetic`);
        }
      }
      // The only absolute paths in a fixture sit under the invented working directory.
      for (const text of allStrings(line)) {
        if (text.startsWith("/") && text !== session.cwd && !text.startsWith(`${session.cwd}/`)) {
          problems.push(`${at} holds a path outside the synthetic project folder`);
        }
      }
    });
  }
  for (const [agentId, meta] of transcripts.metas) {
    if (!marked(meta.description)) problems.push(`${agentId} meta description`);
  }
  return problems;
}

function metaProblems(session: GeneratedSession, transcripts: SessionTranscripts): string[] {
  const problems: string[] = [];
  const byAgent = new Map(allTranscripts(transcripts));
  const facts = new Map(session.expected.agents.map((agent) => [agent.id, agent]));
  for (const subagent of session.subagents) {
    const at = subagent.agentId;
    const meta = transcripts.metas.get(at) as JsonObject;
    const agent = facts.get(at) as AgentFacts;
    const own = byAgent.get(at) as JsonObject[];

    for (const key of Object.keys(meta)) {
      if (!(SUBAGENT_META_KEYS as readonly string[]).includes(key)) {
        problems.push(`${at} meta has an unlisted key ${key}`);
      }
    }
    if (meta.agentType !== subagent.agentType || meta.agentType !== agent.agentType) {
      problems.push(`${at} meta.agentType`);
    }
    if (typeof meta.toolUseId !== "string") problems.push(`${at} meta.toolUseId`);
    if (meta.spawnDepth !== agent.spawnDepth) problems.push(`${at} meta.spawnDepth`);
    if (typeof meta.description !== "string") problems.push(`${at} meta.description`);
    if ("model" in meta && meta.model !== agent.model) problems.push(`${at} meta.model`);
    if ("isBuiltIn" in meta && typeof meta.isBuiltIn !== "boolean") {
      problems.push(`${at} meta.isBuiltIn`);
    }
    if ("finished" in meta && meta.finished !== agent.finished) {
      problems.push(`${at} meta.finished`);
    }

    // The meta file points at the Agent call of the parent that started this subagent.
    const parentFacts = facts.get(String(agent.parent));
    const parentLines = byAgent.get(String(agent.parent));
    if (parentFacts === undefined || parentLines === undefined) {
      problems.push(`${at} has no parent transcript`);
      continue;
    }
    if (agent.spawnDepth !== parentFacts.spawnDepth + 1) problems.push(`${at} depth`);
    const call = toolUseBlocks(parentLines).get(String(meta.toolUseId));
    if (call === undefined) {
      problems.push(`${at} meta.toolUseId is not a tool call of its parent`);
      continue;
    }
    if (call.name !== "Agent") problems.push(`${at} was not started by an Agent call`);
    if (call.input.subagent_type !== meta.agentType) problems.push(`${at} subagent_type`);
    if (call.input.description !== meta.description) problems.push(`${at} description`);

    // The subagent transcript starts with the prompt of that call, after the call.
    const first = own[0] as JsonObject;
    const firstMessage = isObject(first.message) ? first.message : {};
    if (first.type !== "user" || firstMessage.content !== call.input.prompt) {
      problems.push(`${at} does not start with the prompt of its Agent call`);
    }
    if (!(Date.parse(agent.firstTimestamp) > call.time)) {
      problems.push(`${at} starts before its Agent call`);
    }

    // A finished subagent hands back: the parent holds a result, stamped after its last line.
    const result = toolResultBlocks(parentLines).find((item) => item.toolUseId === call.id);
    if (agent.finished && result === undefined) problems.push(`${at} finished without a result`);
    if (!agent.finished && result !== undefined) problems.push(`${at} unfinished with a result`);
    if (result !== undefined && !(result.time > Date.parse(agent.lastTimestamp))) {
      problems.push(`${at} handed back before its last line`);
    }
  }
  return problems;
}

function layoutProblems(session: GeneratedSession): string[] {
  const problems: string[] = [];
  const paths = session.files.map((file) => file.path);
  const projectDir = session.cwd.replace(/[^A-Za-z0-9]/g, "-");
  const sessionFolder = `projects/${projectDir}/${session.sessionId}`;
  if (session.projectDir !== projectDir) problems.push("projectDir is not derived from cwd");
  if (session.transcriptPath !== `${sessionFolder}.jsonl`) problems.push("main transcript path");
  if (paths[0] !== session.transcriptPath) problems.push("the main transcript is not first");
  if (new Set(paths).size !== paths.length) problems.push("a path is written twice");
  if (paths.length !== 1 + 2 * session.subagents.length) problems.push("unexpected file count");
  for (const subagent of session.subagents) {
    const base = `${sessionFolder}/subagents/agent-${subagent.agentId}`;
    if (!/^a[0-9a-f]{16}$/.test(subagent.agentId)) problems.push(`${subagent.agentId} id`);
    if (subagent.transcriptPath !== `${base}.jsonl`) problems.push(`${subagent.agentId} path`);
    if (subagent.metaPath !== `${base}.meta.json`) problems.push(`${subagent.agentId} meta path`);
    if (!paths.includes(subagent.transcriptPath)) problems.push(`${subagent.agentId} no file`);
    if (!paths.includes(subagent.metaPath)) problems.push(`${subagent.agentId} no meta file`);
  }
  for (const path of paths) {
    if (path.includes("\\") || path.startsWith("/") || path.split("/").includes("..")) {
      problems.push(`${path} is not a clean relative path`);
    }
  }
  return problems;
}

describe.each(CASES)("fixture $name, seed '$seed'", ({ name, seed }) => {
  const session = generateSession(name, { seed });
  const transcripts = readSession(session);
  const agents = new Map(session.expected.agents.map((agent) => [agent.id, agent]));

  it("writes every line as one canonical JSON object with a type", () => {
    expect(serialisationProblems(session)).toEqual([]);
    expect(parseJsonl(session.files[0]?.content ?? "").length).toBeGreaterThan(0);
  });

  it("puts the common keys on every conversation line", () => {
    const problems = allTranscripts(transcripts).flatMap(([agentId, lines]) =>
      commonKeyProblems(session, agentId, lines),
    );
    expect(problems).toEqual([]);
  });

  it("keeps timestamps in order, uuids unique and every parent inside its own file", () => {
    expect(chainProblems(transcripts)).toEqual([]);
  });

  it("writes assistant lines with a message id, a model, usage and one content block", () => {
    const problems = allTranscripts(transcripts).flatMap(([agentId, lines]) =>
      assistantProblems(agents.get(agentId) as AgentFacts, lines),
    );
    expect(problems).toEqual([]);
  });

  it("writes user lines as a prompt string or a list of tool_result blocks", () => {
    const problems = allTranscripts(transcripts).flatMap(([agentId, lines]) =>
      userProblems(agentId, lines),
    );
    expect(problems).toEqual([]);
  });

  it("pairs every tool result with an earlier tool call of the same transcript", () => {
    const problems = allTranscripts(transcripts).flatMap(([agentId, lines]) =>
      pairingProblems(agentId, lines),
    );
    expect(problems).toEqual([]);
  });

  it("uses only block types a reader knows, apart from the one invented type", () => {
    const types = new Set(
      allTranscripts(transcripts).flatMap(([, lines]) =>
        lines
          .filter((line) => line.type === "assistant")
          .flatMap((line) => contentBlocks(line).map((block) => String(block.type))),
      ),
    );
    const unknown = [...types].filter((type) => !KNOWN_BLOCK_TYPES.includes(type));
    expect(unknown).toEqual(name === "unknown-lines" ? ["synthetic_future_block"] : []);
  });

  it("lays the files out like a Claude Code config folder", () => {
    expect(layoutProblems(session)).toEqual([]);
  });

  it("writes a meta file per subagent that points at the parent's Agent call", () => {
    expect(metaProblems(session, transcripts)).toEqual([]);
    expect(transcripts.metas.size).toBe(session.subagents.length);
  });

  it("marks all free text as synthetic and keeps paths inside the invented project", () => {
    expect(textProblems(session, transcripts)).toEqual([]);
    expect(session.cwd).toBe(`/workspace/${session.project}`);
  });

  it("states facts that match what can be counted from the lines", () => {
    const counted = allTranscripts(transcripts).map(([agentId, lines]) => ({
      id: agentId,
      ...countedFacts(summarise(lines)),
    }));
    expect(session.expected.agents.map((agent) => agent.id)).toEqual([
      MAIN_AGENT_ID,
      ...session.subagents.map((subagent) => subagent.agentId),
    ]);
    session.expected.agents.forEach((agent, index) => {
      expect(agent).toMatchObject(counted[index] as JsonObject);
    });

    const totals = session.expected.totals;
    const sum = (pick: (agent: AgentFacts) => number): number =>
      session.expected.agents.reduce((total, agent) => total + pick(agent), 0);
    expect(totals.lines).toBe(sum((agent) => agent.lines));
    expect(totals.replies).toBe(sum((agent) => agent.replies));
    expect(totals.toolCalls).toBe(sum((agent) => agent.toolCalls));
    expect(totals.failedToolCalls).toBe(sum((agent) => agent.failedToolCalls));
    expect(totals.unfinishedToolCalls).toBe(sum((agent) => agent.unfinishedToolCalls));
    expect(totals.mcpToolCalls).toBe(sum((agent) => agent.mcpToolCalls));
    for (const key of USAGE_KEYS) {
      expect(totals.usage[key]).toBe(sum((agent) => agent.usage[key]));
    }
  });

  it("states the waves and idle gaps that the timestamps show", () => {
    expect(countWaves(subagentStartTimes(transcripts))).toBe(session.expected.scriptedWaves);
    expect(idleGaps(transcripts.main)).toEqual(
      session.expected.scriptedIdleGaps.map((gap) => gap.seconds),
    );
  });
});

describe("the shape checks", () => {
  // A check that can never fail proves nothing: break a fixture and see each check object.
  const session = generateSession("two-waves");
  const fresh = (): SessionTranscripts => readSession(session);
  const mainAgent = session.expected.agents[0] as AgentFacts;

  it("notice a conversation line without a common key", () => {
    const { main } = fresh();
    const line = main.find((candidate) => candidate.type === "assistant") as JsonObject;
    delete line.cwd;
    expect(commonKeyProblems(session, MAIN_AGENT_ID, main)).toHaveLength(2);
  });

  it("notice a timestamp that goes back and a parent from nowhere", () => {
    const transcripts = fresh();
    const stamped = transcripts.main.filter((line) => typeof line.uuid === "string");
    (stamped[3] as JsonObject).timestamp = "2020-01-01T00:00:00.000Z";
    (stamped[5] as JsonObject).parentUuid = "00000000-0000-4000-8000-000000000000";
    expect(chainProblems(transcripts)).toHaveLength(2);
  });

  it("notice an assistant line with broken usage, model or effort", () => {
    const { main } = fresh();
    const line = main.find((candidate) => candidate.type === "assistant") as JsonObject;
    const message = line.message as JsonObject;
    (message.usage as JsonObject).output_tokens = -1;
    message.model = "claude-other-1";
    line.effort = "extreme";
    expect(assistantProblems(mainAgent, main)).toEqual([
      expect.stringContaining("message.model"),
      expect.stringContaining("usage.output_tokens"),
      expect.stringContaining("effort"),
      expect.stringContaining("effort is not a known level"),
    ]);
  });

  it("notice a tool result that answers no call, or the same call twice", () => {
    const { main } = fresh();
    const results = toolResultBlocks(main);
    (results[0] as { block: JsonObject }).block.tool_use_id = "toolu_01SYNTHmissing";
    (results[2] as { block: JsonObject }).block.tool_use_id = (
      results[1] as { toolUseId: string }
    ).toolUseId;
    const problems = pairingProblems(MAIN_AGENT_ID, main);
    expect(problems).toContainEqual(expect.stringContaining("not in this transcript"));
    expect(problems).toContainEqual(expect.stringContaining("a second time"));
  });

  it("notice a user line whose is_error is not a boolean", () => {
    const { main } = fresh();
    (toolResultBlocks(main)[0] as { block: JsonObject }).block.is_error = "no";
    expect(userProblems(MAIN_AGENT_ID, main)).toHaveLength(1);
  });

  it("notice a meta file that points at the wrong call, and real-looking text", () => {
    const transcripts = fresh();
    const [first, second] = [...transcripts.metas.values()] as [JsonObject, JsonObject];
    first.toolUseId = "toolu_01SYNTHmissing";
    second.description = "An unmarked description";
    expect(metaProblems(session, transcripts)).toContainEqual(
      expect.stringContaining("not a tool call of its parent"),
    );
    const prompt = transcripts.main.find((line) => line.type === "user") as JsonObject;
    (prompt.message as JsonObject).content = "/somewhere/else";
    expect(textProblems(session, transcripts)).toEqual([
      expect.stringContaining("prompt is not marked synthetic"),
      expect.stringContaining("outside the synthetic project folder"),
      expect.stringContaining("meta description"),
    ]);
  });

  it("notice a file that is not canonical JSON lines", () => {
    const broken: GeneratedSession = {
      ...session,
      files: [{ path: session.transcriptPath, content: '{"type":"user"}\n{ "type": 1 }\nnope' }],
    };
    expect(serialisationProblems(broken)).toEqual([
      expect.stringContaining("does not end with a newline"),
      expect.stringContaining(":2 has no type"),
      expect.stringContaining(":2 is not in canonical form"),
      expect.stringContaining(":3 is not valid JSON"),
    ]);
    expect(layoutProblems(broken)).toContain("unexpected file count");
  });
});
