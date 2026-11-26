/**
 * Builders for synthetic transcript lines, in the raw line shape Claude Code writes.
 * Every value is invented. Strings that stand for user content start with `SECRET-`, so a
 * test can check that none of them reaches the parsed session.
 */

export const SESSION_ID = "demo-session-0001";
export const CONTENT_MARKER = "SECRET-";

/** Epoch milliseconds of `10:<mm>:<ss>` on an invented day. */
export function at(time: string): number {
  return Date.parse(`2030-01-02T10:${time}.000Z`);
}

/** ISO timestamp of `10:<mm>:<ss>` on the same invented day. */
export function iso(time: string): string {
  return new Date(at(time)).toISOString();
}

interface Common {
  readonly time?: string;
  readonly version?: string;
  readonly uuid?: string;
}

function common(options: Common): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sessionId: SESSION_ID,
    cwd: `${CONTENT_MARKER}/workspace/example-project`,
    gitBranch: `${CONTENT_MARKER}feature/demo`,
    version: options.version ?? "9.9.1",
    entrypoint: "cli",
    isSidechain: false,
  };
  if (options.time !== undefined) base["timestamp"] = iso(options.time);
  if (options.uuid !== undefined) base["uuid"] = options.uuid;
  return base;
}

export function toolUse(id: string, name: string): Record<string, unknown> {
  return {
    type: "tool_use",
    id,
    name,
    input: { file_path: `${CONTENT_MARKER}src/widget.ts`, command: `${CONTENT_MARKER}run` },
  };
}

export function toolResult(toolUseId: string, isError?: boolean): Record<string, unknown> {
  const block: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: `${CONTENT_MARKER}tool output`,
  };
  if (isError !== undefined) block["is_error"] = isError;
  return block;
}

export function text(): Record<string, unknown> {
  return { type: "text", text: `${CONTENT_MARKER}reply text` };
}

export function thinking(): Record<string, unknown> {
  return { type: "thinking", thinking: `${CONTENT_MARKER}thinking text` };
}

export interface Usage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
}

export function assistant(
  options: Common & {
    readonly id?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly usage?: Usage;
    readonly content?: readonly unknown[];
  },
): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: options.content ?? [text()],
  };
  if (options.id !== undefined) message["id"] = options.id;
  if (options.model !== undefined) message["model"] = options.model;
  if (options.usage !== undefined) {
    message["usage"] = {
      input_tokens: options.usage.input ?? 0,
      output_tokens: options.usage.output ?? 0,
      cache_read_input_tokens: options.usage.cacheRead ?? 0,
      cache_creation_input_tokens: options.usage.cacheCreation ?? 0,
      service_tier: "standard",
    };
  }
  const line: Record<string, unknown> = { type: "assistant", ...common(options), message };
  if (options.effort !== undefined) line["effort"] = options.effort;
  return JSON.stringify(line);
}

export function userPrompt(options: Common): string {
  return JSON.stringify({
    type: "user",
    ...common(options),
    message: { role: "user", content: `${CONTENT_MARKER}please refactor the widget` },
  });
}

export function userResults(options: Common & { readonly results: readonly unknown[] }): string {
  return JSON.stringify({
    type: "user",
    ...common(options),
    message: { role: "user", content: options.results },
    toolUseResult: { stdout: `${CONTENT_MARKER}output` },
  });
}

/** Any other line type, known or not. `type: undefined` leaves the key out. */
export function other(type: string | undefined, options: Common = {}): string {
  const line: Record<string, unknown> = { ...common(options), detail: `${CONTENT_MARKER}x` };
  if (type !== undefined) line["type"] = type;
  return JSON.stringify(line);
}

/** An async line source, as a host adapter reading a file stream would give. */
export async function* asyncLines(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) {
    await Promise.resolve();
    yield line;
  }
}
