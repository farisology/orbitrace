/**
 * A file the user dropped or picked, turned into a replay inside the page. Nothing is sent
 * anywhere: dropped files never use the host transport (see transport.ts).
 *
 * - `.replay.json` (or any `.json`): parsed and checked with `validateReplay`; the reasons it
 *   fails come from `describeReplayProblems`, which never quotes a value from the file.
 * - `.jsonl`: a Claude Code transcript. The whole text is handed to `parseSession` as one item
 *   (the parser splits it into lines), then `buildReplay` makes the replay. Only the main
 *   transcript is in one file, so subagents are not shown; their calls still are.
 *
 * Error messages are fixed text: they never include the file name or any of its content.
 */

import {
  buildReplay,
  describeReplayProblems,
  parseSession,
  validateReplay,
  type ReplayModel,
} from "@orbitrace/core";

export type DroppedKind = "replay" | "transcript";

export type FileLoadResult =
  | { readonly ok: true; readonly kind: DroppedKind; readonly model: ReplayModel }
  | { readonly ok: false; readonly error: FileLoadError };

export interface FileLoadError {
  readonly title: string;
  /** One line per reason, safe to show. Empty when the title says it all. */
  readonly problems: readonly string[];
}

export const FILE_MESSAGES = {
  unsupported:
    "This file type is not supported. Drop a .replay.json replay or a .jsonl transcript.",
  notJson: "This file is not valid JSON, so it is not a replay.",
  invalidReplay: "This file is not a valid Orbitrace replay (format version 1).",
  emptyTranscript: "This transcript has no lines.",
  noTimedLines: "No transcript lines with a timestamp were found, so there is nothing to replay.",
  buildFailed: "A replay could not be built from this transcript.",
  unreadable: "The file could not be read.",
} as const;

const fail = (title: string, problems: readonly string[] = []): FileLoadResult => ({
  ok: false,
  error: { title, problems },
});

/** What kind of file a name is, by its extension, or `null` when it is neither. */
export function droppedKind(fileName: string): DroppedKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jsonl")) return "transcript";
  if (lower.endsWith(".json")) return "replay";
  return null;
}

/** Check parsed JSON as a replay v1. */
export function replayFromValue(value: unknown): FileLoadResult {
  if (validateReplay(value)) return { ok: true, kind: "replay", model: value };
  return fail(FILE_MESSAGES.invalidReplay, describeReplayProblems(value));
}

/** Parse the text of a `.replay.json` file. */
export function replayFromJson(text: string): FileLoadResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(FILE_MESSAGES.notJson);
  }
  return replayFromValue(value);
}

/** Parse a transcript's text and build its replay, in the page. */
export async function replayFromTranscript(text: string): Promise<FileLoadResult> {
  let model: ReplayModel;
  try {
    const parsed = await parseSession({ main: [text], subagents: [] });
    if (parsed.lines.total === 0) return fail(FILE_MESSAGES.emptyTranscript);
    if (parsed.main.startedAt === null) {
      const problems =
        parsed.lines.malformed > 0
          ? [`${parsed.lines.malformed} of ${parsed.lines.total} lines were not JSON objects.`]
          : [];
      return fail(FILE_MESSAGES.noTimedLines, problems);
    }
    model = buildReplay(parsed);
  } catch {
    return fail(FILE_MESSAGES.buildFailed);
  }
  if (!validateReplay(model)) {
    return fail(FILE_MESSAGES.buildFailed, describeReplayProblems(model));
  }
  return { ok: true, kind: "transcript", model };
}

/** Turn a file's name and text into a replay or a reason it cannot be shown. */
export async function loadFileText(fileName: string, text: string): Promise<FileLoadResult> {
  const kind = droppedKind(fileName);
  if (kind === "replay") return replayFromJson(text);
  if (kind === "transcript") return replayFromTranscript(text);
  return fail(FILE_MESSAGES.unsupported);
}

/** Read a `File` (from a drop or a file picker) and load it. */
export async function loadFile(file: Pick<File, "name" | "text">): Promise<FileLoadResult> {
  if (droppedKind(file.name) === null) return fail(FILE_MESSAGES.unsupported);
  let text: string;
  try {
    text = await file.text();
  } catch {
    return fail(FILE_MESSAGES.unreadable);
  }
  return loadFileText(file.name, text);
}
