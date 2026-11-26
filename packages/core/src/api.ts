/**
 * Function signatures of @orbitrace/core. Signatures only: no function here is implemented
 * yet. Each implementing ticket exports a value of the matching type, for example
 * `export const parseSession: ParseSession = async (input) => { ... }`.
 *
 * Data flow: SourceAdapter -> SessionInput -> parseSession -> ParsedSession
 * -> buildReplay -> ReplayModel -> renderer / exportReplay.
 *
 * `parseSession`, `buildReplay` and `validateReplay` run on the host (Node) and inside the
 * app (browser or editor webview), where the app handles a file the user dropped. They must
 * not use Node or DOM APIs.
 */

import type { ParsedSession } from "./model/parsed.js";
import type { SessionInput } from "./model/raw.js";
import type { ReplayModel } from "./model/replay.js";
import type {
  ListSessionsOptions,
  ResolveRootsContext,
  SessionRef,
  SourceAdapter,
  SourceRoot,
} from "./model/sources.js";

/**
 * Ticket #6. Read every line of a session and return the merged structure.
 *
 * Must: merge assistant lines by `message.id` (max of each usage field, union of tool_use
 * blocks by id); pair each tool_result with its call by `tool_use_id`; link each subagent
 * run to the parent's `Agent` call via the meta `toolUseId`; set each call's `kind` from the
 * runtime's tool name (see `ParsedToolCall.kind`); skip and count unknown and malformed
 * lines; never throw on a bad line; never keep text, inputs, outputs or the meta
 * `description`.
 */
export type ParseSession = (input: SessionInput) => Promise<ParsedSession>;

/** Options for `buildReplay`. Every field has a default. */
export interface BuildReplayOptions {
  /** An idle gap longer than this many seconds is cut. Default 45. */
  readonly idleGapSeconds?: number;
  /** Seconds an idle gap is cut down to. Default 8. */
  readonly idleKeepSeconds?: number;
  /** A subagent starting more than this many seconds after the previous one opens a new wave. Default 60. */
  readonly waveGapSeconds?: number;
  /** Seconds of busy time counted around each reply when finding idle gaps. Default chosen by ticket #8. */
  readonly replyPaddingSeconds?: number;
  /**
   * Snapshot time for a live session, Unix epoch milliseconds. Agents and calls still
   * open at this time keep `end: null`. Default: the last timestamp in the session.
   */
  readonly now?: number;
  /**
   * The snapshot built for the same session just before this one (live view). When given,
   * the result keeps the append-stability rules in `model/replay.ts`: existing agents keep
   * id, callsign, parent, wave and index; tool calls and replies are only filled in or
   * appended; existing warps stay where they are. The host that watches a session (#12,
   * #16) passes the last model it sent. Leave it out for a one-off build or an export.
   *
   * It must come from the same session and an earlier `now`. When the session no longer
   * contains what `previous` describes (for example the transcript was replaced), the
   * builder makes a fresh build; the guarantees do not hold across that one step.
   */
  readonly previous?: ReplayModel;
}

/** Defaults taken from the prototype. `replyPaddingSeconds` is left to ticket #8. */
export const REPLAY_BUILD_DEFAULTS = {
  idleGapSeconds: 45,
  idleKeepSeconds: 8,
  waveGapSeconds: 60,
} as const satisfies BuildReplayOptions;

/**
 * Ticket #8. Turn a parsed session into a structure-only replay. Pure and synchronous.
 * Copies each call's `kind` from the parsed call and never derives it from the name.
 * The result must validate against `schema/replay-v1.schema.json`.
 */
export type BuildReplay = (session: ParsedSession, options?: BuildReplayOptions) => ReplayModel;

/**
 * Ticket #7. Ask each adapter for its roots and return them in resolution order
 * (user setting, environment, OS default, extra roots, hooks), duplicates removed.
 */
export type ResolveSources = (
  context: ResolveRootsContext,
  adapters: readonly SourceAdapter[],
) => Promise<readonly SourceRoot[]>;

/**
 * Ticket #7. List sessions under the given roots, newest first, using the adapter whose
 * `runtime` matches each root. A root that cannot be read yields no sessions, not an error.
 */
export type ListSessions = (
  roots: readonly SourceRoot[],
  adapters: readonly SourceAdapter[],
  options?: ListSessionsOptions,
) => Promise<readonly SessionRef[]>;

/** Export formats. v1 has one: the replay as JSON. */
export type ExportFormat = "replay-json";

export interface ExportOptions {
  /** Default `replay-json`. */
  readonly format?: ExportFormat;
  /** Indent the JSON for reading. Default false. */
  readonly pretty?: boolean;
}

export interface ExportResult {
  readonly format: ExportFormat;
  /** Suggested file name, ending in `.replay.json`. Must not contain a session id or project name. */
  readonly fileName: string;
  readonly mediaType: "application/json";
  readonly data: string;
}

/**
 * Ticket #18. Serialise a replay for sharing. Must validate the model against the schema
 * first and throw when it does not validate, so no extra field can leave the machine.
 */
export type ExportReplay = (model: ReplayModel, options?: ExportOptions) => ExportResult;

/**
 * Ticket #18. Check an unknown value (for example a dropped `.replay.json`) against the
 * v1 schema. The app and the CLI call it before handing a file to the renderer.
 */
export type ValidateReplay = (value: unknown) => value is ReplayModel;

/** The whole public surface of core once every ticket has landed. */
export interface CoreApi {
  readonly parseSession: ParseSession;
  readonly buildReplay: BuildReplay;
  readonly resolveSources: ResolveSources;
  readonly listSessions: ListSessions;
  readonly exportReplay: ExportReplay;
  readonly validateReplay: ValidateReplay;
}
