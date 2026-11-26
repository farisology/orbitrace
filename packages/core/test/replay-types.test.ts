// Type-level tests. They run under `npm run typecheck` (tsc includes test/); the runtime
// assertions only make vitest report them.
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BuildReplay,
  CoreApi,
  ExportReplay,
  ForbiddenReplayKey,
  KnownModelFamily,
  ListSessions,
  ModelFamily,
  ParsedSession,
  ParsedToolCall,
  ParseSession,
  RawLine,
  RawSubagentMeta,
  ReplayAgentId,
  ReplayMainAgent,
  ReplayModel,
  ReplayReply,
  ReplaySubagent,
  ReplayToolCall,
  ResolveSources,
  SessionInput,
  SessionRef,
  SessionSummary,
  SourceAdapter,
  ToolKind,
  ValidateReplay,
} from "../src/index.js";
import { FORBIDDEN_REPLAY_KEYS, KNOWN_RAW_LINE_TYPES } from "../src/index.js";

/** Every property name reachable from T, through arrays, tuples and unions. */
type DeepKeys<T> = T extends readonly (infer U)[]
  ? DeepKeys<U>
  : T extends object
    ? { [K in keyof T]-?: K | DeepKeys<T[K]> }[keyof T]
    : never;

/** Content a parsed session must not hold either (local ids are allowed there). */
type ContentKey =
  | "text"
  | "thinking"
  | "content"
  | "prompt"
  | "input"
  | "output"
  | "path"
  | "command"
  | "cwd"
  | "gitBranch"
  | "title"
  | "description";

describe("replay types", () => {
  it("declare no forbidden key anywhere in ReplayModel", () => {
    expectTypeOf<Extract<DeepKeys<ReplayModel>, ForbiddenReplayKey>>().toEqualTypeOf<never>();
    expect(FORBIDDEN_REPLAY_KEYS.length).toBeGreaterThan(0);
  });

  it("declare no content key anywhere in ParsedSession", () => {
    expectTypeOf<Extract<DeepKeys<ParsedSession>, ContentKey>>().toEqualTypeOf<never>();
  });

  it("keep family open while naming the known values", () => {
    expectTypeOf<"gpt">().toExtend<ModelFamily>();
    expectTypeOf<KnownModelFamily>().toExtend<ModelFamily>();
    expectTypeOf<KnownModelFamily>().toEqualTypeOf<
      "fable" | "opus" | "sonnet" | "haiku" | "unknown"
    >();
    expectTypeOf<ReplaySubagent["family"]>().toEqualTypeOf<ModelFamily>();
  });

  it("reject extra fields at compile time", () => {
    const tool: ReplayToolCall = {
      name: "Read",
      kind: "read",
      start: 0,
      end: 1,
      failed: false,
      // @ts-expect-error a tool call has no input field
      input: "x",
    };
    const reply: ReplayReply = {
      t: 0,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      // @ts-expect-error a reply has no text field
      text: "x",
    };
    expect([tool, reply]).toHaveLength(2);
  });

  it("give every tool call a runtime-independent kind, set by the parser", () => {
    expectTypeOf<ReplayToolCall["kind"]>().toEqualTypeOf<ToolKind>();
    expectTypeOf<ParsedToolCall["kind"]>().toEqualTypeOf<ToolKind>();
    expectTypeOf<ToolKind>().toEqualTypeOf<"shell" | "read" | "edit" | "agent" | "mcp" | "other">();
    // @ts-expect-error kind is required
    const noKind: ReplayToolCall = { name: "Read", start: 0, end: 1, failed: false };
    // @ts-expect-error a runtime tool name is not a kind
    const badKind: ReplayToolCall = { name: "Bash", kind: "Bash", start: 0, end: 1, failed: false };
    expect([noKind, badKind]).toHaveLength(2);
  });

  it("keep the main agent first and give subagents a parent and a wave", () => {
    expectTypeOf<ReplayModel["agents"][0]>().toEqualTypeOf<ReplayMainAgent>();
    expectTypeOf<ReplayMainAgent["parent"]>().toEqualTypeOf<null>();
    expectTypeOf<ReplaySubagent["parent"]>().toEqualTypeOf<ReplayAgentId>();
    expectTypeOf<ReplaySubagent["wave"]>().toEqualTypeOf<number>();
  });
});

describe("raw types", () => {
  it("represent unknown line types and unknown keys", () => {
    const unknownLine: RawLine = { type: "some-future-type", extra: { nested: true } };
    const noType: RawLine = { uuid: "u-1" };
    const meta: RawSubagentMeta = { agentType: "test-runner", somethingNew: 1 };
    expect(KNOWN_RAW_LINE_TYPES).not.toContain(unknownLine.type);
    expect([noType, meta]).toHaveLength(2);
  });
});

describe("api signatures", () => {
  it("chain from a source adapter to a replay", () => {
    expectTypeOf<ReturnType<SourceAdapter["openSession"]>>().toEqualTypeOf<Promise<SessionInput>>();
    expectTypeOf<Parameters<ParseSession>[0]>().toEqualTypeOf<SessionInput>();
    expectTypeOf<ReturnType<ParseSession>>().toEqualTypeOf<Promise<ParsedSession>>();
    expectTypeOf<Parameters<BuildReplay>[0]>().toEqualTypeOf<ParsedSession>();
    expectTypeOf<ReturnType<BuildReplay>>().toEqualTypeOf<ReplayModel>();
    expectTypeOf<Parameters<ExportReplay>[0]>().toEqualTypeOf<ReplayModel>();
    expectTypeOf<ReturnType<ListSessions>>().toEqualTypeOf<Promise<readonly SessionRef[]>>();
    expectTypeOf<CoreApi["resolveSources"]>().toEqualTypeOf<ResolveSources>();
    expectTypeOf<CoreApi["validateReplay"]>().toEqualTypeOf<ValidateReplay>();
  });

  it("keep paths and locators out of a session summary", () => {
    expectTypeOf<Extract<keyof SessionSummary, "source" | "locator">>().toEqualTypeOf<never>();
  });
});
