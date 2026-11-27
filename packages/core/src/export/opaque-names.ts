/**
 * Ticket #122 (finding F2 of docs/security/export-audit.md). The `names: "opaque"` export
 * option: names a user can choose are replaced by labels that say nothing about them.
 *
 * - Every subagent's agent type becomes `agent-1`, `agent-2`, ... Its callsign keeps its `#n`,
 *   so `code-reviewer#2` becomes `agent-1#2`. The main agent stays `main`.
 * - Every MCP server becomes `mcp:server-1`, `mcp:server-2`, ... `mcp:unknown` (the builder's
 *   fixed label for a server name it could not keep) stays.
 * - Every tool name outside `OPAQUE_KEPT_TOOL_NAMES` becomes `tool_1`, `tool_2`, ... The schema's
 *   tool name pattern allows no `-`, so the label has an underscore.
 * - Every model id that is not a known Claude model id (`isKnownModelId`) becomes `null`. The
 *   family is kept when it is one of `KNOWN_MODEL_FAMILIES` and becomes `unknown` otherwise:
 *   a family word outside that list is a part of the model id (`claude-<word>-...`).
 *
 * Labels are numbered in order of first appearance within one export: agents in id order; tools
 * by agent in id order, then by their order in `tools`. The same name always gets the same label
 * within one export; different names get different labels. A label is a counter, never a hash
 * or any other function of the name, and no mapping table is written, so a label cannot be
 * turned back into the name. What still shows: how many distinct names there are, which agents
 * and calls share one, and the order in which they first appear.
 */
import {
  KNOWN_MODEL_FAMILIES,
  type ModelFamily,
  type ReplayAgent,
  type ReplayModel,
  type ReplaySubagent,
  type ReplayToolCall,
} from "../model/replay.js";
import { assignCallsigns, FALLBACK_MCP_SERVER, FALLBACK_TOOL_NAME } from "../replay/names.js";

/** Prefix of an opaque agent type label: `agent-1`, `agent-2`, ... */
export const OPAQUE_AGENT_PREFIX = "agent-";

/** Prefix of an opaque MCP tool label: `mcp:server-1`, `mcp:server-2`, ... */
export const OPAQUE_MCP_PREFIX = "mcp:server-";

/** Prefix of an opaque tool label: `tool_1`, `tool_2`, ... */
export const OPAQUE_TOOL_PREFIX = "tool_";

/**
 * Tool names `names: "opaque"` keeps as they are, because they are generic and carry no private
 * information: the tools the parser classifies by name (`Bash`, `Read`, `Grep`, `Glob`, `Edit`,
 * `Write`, `Agent`, `Task`, `SubagentHandback`), other generic Claude Code tool names, and the
 * builder's fixed labels `unknown` (a name it could not keep) and `mcp` (a raw MCP name on a call
 * that is not an MCP call). Any other name, including one a newer Claude Code release adds, is
 * written as `tool_<n>` until it is added here.
 */
export const OPAQUE_KEPT_TOOL_NAMES: readonly string[] = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "LS",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Read",
  "Skill",
  "SlashCommand",
  "SubagentHandback",
  "Task",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
  FALLBACK_TOOL_NAME,
  "mcp",
];

const KEPT_TOOLS: ReadonlySet<string> = new Set(OPAQUE_KEPT_TOOL_NAMES);

/** Model families with a name: every entry of `KNOWN_MODEL_FAMILIES` except `unknown`. */
const NAMED_FAMILIES = KNOWN_MODEL_FAMILIES.filter((family) => family !== "unknown");

const FAMILY_GROUP = `(?:${NAMED_FAMILIES.join("|")})`;
const VERSION = String.raw`\d{1,4}(?:-\d{1,4}){0,2}`;
const SUFFIX = String.raw`(?:-\d{8}|-latest)?`;

/**
 * A Claude model id with a family of `KNOWN_MODEL_FAMILIES`: `claude-<family>-<version>`
 * (`claude-opus-5-5`, `claude-haiku-5-5-20260115`), the older `claude-<version>-<family>`
 * (`claude-3-5-sonnet-20241022`), each with an optional 8-digit date or `-latest`, or a bare
 * family alias (`sonnet`). Digits only besides the family word, so nothing a user named passes.
 */
const KNOWN_MODEL_ID = new RegExp(
  `^(?:${FAMILY_GROUP}|claude-(?:${FAMILY_GROUP}-${VERSION}|${VERSION}-${FAMILY_GROUP})${SUFFIX})$`,
);

/** Whether a model id is a known Claude model id that `names: "opaque"` keeps (see above). */
export function isKnownModelId(model: string): boolean {
  return KNOWN_MODEL_ID.test(model);
}

/** Gives each distinct name the next label, in order of first appearance. */
class Labeller {
  private readonly labels = new Map<string, string>();

  constructor(private readonly prefix: string) {}

  label(name: string): string {
    let label = this.labels.get(name);
    if (label === undefined) {
      label = `${this.prefix}${this.labels.size + 1}`;
      this.labels.set(name, label);
    }
    return label;
  }
}

/** `#n` when a callsign is its name plus a repeat suffix, `""` when it is the name, else `null`. */
function callsignSuffix(name: string, callsign: string): string | null {
  if (callsign === name) return "";
  if (!callsign.startsWith(`${name}#`)) return null;
  const suffix = callsign.slice(name.length);
  return /^#[1-9][0-9]{0,5}$/.test(suffix) ? suffix : null;
}

function opaqueModel(agent: ReplayAgent): { model: string | null; family: ModelFamily } {
  const family = (KNOWN_MODEL_FAMILIES as readonly string[]).includes(agent.family)
    ? agent.family
    : "unknown";
  const model = agent.model !== null && isKnownModelId(agent.model) ? agent.model : null;
  return { model, family };
}

/**
 * The replay with every agent type, MCP server, non-built-in tool name and unknown model id
 * replaced as described at the top of this file. Pure: the input is not changed, and the result
 * keeps the input's key order, structure, times and counts. The input must be a valid replay v1.
 */
export function opaqueNames(model: ReplayModel): ReplayModel {
  const agentLabels = new Labeller(OPAQUE_AGENT_PREFIX);
  const serverLabels = new Labeller(OPAQUE_MCP_PREFIX);
  const toolLabels = new Labeller(OPAQUE_TOOL_PREFIX);

  const toolName = (name: string): string => {
    if (name.startsWith("mcp:")) {
      const server = name.slice("mcp:".length);
      return server === FALLBACK_MCP_SERVER ? name : serverLabels.label(server);
    }
    return KEPT_TOOLS.has(name) ? name : toolLabels.label(name);
  };
  const tools = (list: readonly ReplayToolCall[]): ReplayToolCall[] =>
    list.map((tool) => ({ ...tool, name: toolName(tool.name) }));

  const [main, ...subagents] = model.agents;
  const names = subagents.map((agent) => agentLabels.label(agent.name));
  const suffixes = subagents.map((agent) => callsignSuffix(agent.name, agent.callsign));
  // A callsign the builder did not form as `name` or `name#n` cannot keep its suffix: number
  // every subagent again from the labels, the way the builder numbers names.
  const callsigns = suffixes.every((suffix) => suffix !== null)
    ? names.map((label, index) => `${label}${suffixes[index] ?? ""}`)
    : assignCallsigns([main.name, ...names], [main.callsign]).slice(1);

  const opaqueMain = { ...main, ...opaqueModel(main), tools: tools(main.tools) };
  const opaqueSubagents = subagents.map((agent, index): ReplaySubagent => ({
    ...agent,
    name: names[index] as string,
    callsign: callsigns[index] as string,
    ...opaqueModel(agent),
    tools: tools(agent.tools),
  }));
  return { ...model, agents: [opaqueMain, ...opaqueSubagents] };
}
