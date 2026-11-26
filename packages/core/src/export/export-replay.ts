/**
 * Ticket #18. Structure-only replay export.
 *
 * Guarantees, for every `ExportResult` this returns:
 *
 * - The data is JSON of a value built by `projectReplay` from an allow-list of the ReplayModel
 *   fields. Only properties the replay v1 types and schema list can appear; any other property
 *   of the input, at any depth, is dropped, never copied.
 * - That value passed the replay v1 schema check before it was serialised. The schema limits
 *   every string to an identifier pattern with no spaces, slashes, backslashes or line breaks, and
 *   rejects NaN and Infinity, so message text, file paths and command lines cannot be stored in
 *   any string field.
 * - The same input gives the same bytes: keys are written in a fixed order, whatever the order
 *   of the input's keys.
 * - The suggested file name is fixed and holds no session id or project name.
 *
 * Not guaranteed:
 *
 * - The values that are allowed are still real: agent type names, callsigns, model ids, tool
 *   names (`mcp:<server>` keeps the MCP server name), times and token counts. A custom agent type
 *   or MCP server named after a project or client is exported as it is, and an identifier-shaped
 *   secret placed in a name field by a caller would pass the pattern check.
 * - The rules the schema cannot express (totals equal the sums, parents exist, ids in order,
 *   unique callsigns) are not checked here; the replay builder keeps them.
 * - Values the caller passes in are trusted to be the caller's own replay. Export does not
 *   decide whether sharing them is wise; the user must still look at the names before posting.
 */
import type { ExportFormat, ExportReplay, ExportResult } from "../api.js";
import { projectReplay } from "./project.js";
import { describeReplayProblems, ReplayValidationError } from "./validate.js";

/** Suggested file name of every export. Fixed, so it never names a session or project. */
export const REPLAY_EXPORT_FILE_NAME = "orbitrace.replay.json";

const FORMATS: readonly ExportFormat[] = ["replay-json"];

function isFormat(value: unknown): value is ExportFormat {
  return (FORMATS as readonly unknown[]).includes(value);
}

/**
 * Serialises a replay for sharing. Builds a new value from the allow-list, checks it against the
 * replay v1 schema and throws a `ReplayValidationError` when it does not pass. Extra properties
 * on the input are dropped, not reported. The data ends with a line break.
 */
export const exportReplay: ExportReplay = (model, options = {}): ExportResult => {
  const format: unknown = options.format ?? "replay-json";
  if (!isFormat(format)) {
    throw new TypeError(`Unknown export format; expected one of: ${FORMATS.join(", ")}`);
  }
  if (options.pretty !== undefined && typeof options.pretty !== "boolean") {
    throw new TypeError("ExportOptions.pretty must be a boolean");
  }

  const projected = projectReplay(model);
  const problems = describeReplayProblems(projected);
  if (problems.length > 0) throw new ReplayValidationError(problems);

  const data = `${JSON.stringify(projected, null, options.pretty === true ? 2 : undefined)}\n`;
  return { format, fileName: REPLAY_EXPORT_FILE_NAME, mediaType: "application/json", data };
};
