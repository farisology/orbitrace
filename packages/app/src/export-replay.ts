/**
 * Exporting the replay on screen from the app (issue 168), with the three opt-in privacy options of
 * core (issues 122 and 123), all off by default.
 *
 * The file is always made by core's `exportReplay`: an allow-list projection of the model, a
 * schema check, then the chosen options and a second check. Never `JSON.stringify` of the app's
 * model. With no option chosen the bytes are exactly what `orbitrace export` writes for the same
 * session (`test/e2e-http/export-cli.test.ts`). A live session's export is a snapshot of the
 * moment it is made.
 *
 * Saving depends on the host: a browser page (the CLI's loopback server and the no-host app)
 * downloads a Blob (`downloadReplay`); the editor tab sends the text to the extension, which asks
 * where to save it (`WebviewTransport.saveReplay`). The file name is the one `exportReplay` gives
 * (`orbitrace.replay.json`): it never names a session or a project.
 */

import {
  ROUND_TIMES_MAX_STEP,
  ROUND_TIMES_MIN_STEP,
  exportReplay,
  isRoundTimesStep,
  type ExportOptions,
  type ReplayModel,
} from "@orbitrace/core";

/** What the user chose in the export dialog. */
export interface ExportChoices {
  /** `names: "opaque"`. */
  readonly opaqueNames: boolean;
  /** `roundTimes`, with the step below. */
  readonly roundTimes: boolean;
  /** Seconds to round every time to, used only when `roundTimes` is on. */
  readonly roundStep: number;
  /** `bucketTokens`. */
  readonly bucketTokens: boolean;
}

/** The rounding step offered first: a tenth of a second, the example `orbitrace export` uses. */
export const DEFAULT_ROUND_STEP = 0.1;

/** Every option off (owner decision on issues 122 and 123). */
export const DEFAULT_EXPORT_CHOICES: ExportChoices = {
  opaqueNames: false,
  roundTimes: false,
  roundStep: DEFAULT_ROUND_STEP,
  bucketTokens: false,
};

/**
 * The words of the export dialog. Each option's sentence says what it hides and what it does not,
 * in the words of docs/privacy.md and docs/cli.md, so the app and the command line say the same.
 */
export const EXPORT_TEXT = {
  button: "Export",
  title: "Export replay",
  contains:
    "A replay holds the session's structure, agent and tool names, timings and token counts. It never holds prompts, replies, tool inputs or tool output.",
  live: "The session is still running: the file is a snapshot of this moment.",
  optionsLegend: "Privacy options, all off by default",
  opaqueNames: "Opaque names",
  opaqueNamesHelp:
    "Replaces agent types, MCP server names, tool names that are not built in, and unknown model ids with numbered labels. It does not hide built-in tool names, known Claude model ids, or how many distinct names there are.",
  roundTimes: "Round times",
  roundStep: "Step in seconds",
  roundTimesHelp:
    "Rounds every time to the step, which hides exact times. The order of everything and rough durations stay.",
  bucketTokens: "Bucket tokens",
  bucketTokensHelp:
    "Writes each reply's token counts as the nearest of 1, 2, 5, 10, 20, 50 and so on. It hides exact sizes, not rough ones.",
  structure:
    "None of the options hides the structure: agents, who started whom, waves, tool calls and their kinds, failures and replies.",
  checkNames:
    "Without opaque names, agent types, model ids and MCP server names are written as they are: look at them before you share the file.",
  badStep: `The step must be from ${ROUND_TIMES_MIN_STEP} to ${ROUND_TIMES_MAX_STEP} seconds, in whole milliseconds.`,
  save: "Save replay",
  download: "Download replay",
  cancel: "Cancel",
} as const;

/** What happened to an export once the file was made. */
export type SaveOutcome = "saved" | "downloaded" | "cancelled";

/** A replay file ready to save. */
export interface ReplayFile {
  /** The name `exportReplay` suggests: always `orbitrace.replay.json`. */
  readonly fileName: string;
  readonly data: string;
}

/**
 * How the host saves a replay file. Resolves with what happened; rejects with a
 * `TransportError` when the file could not be saved.
 */
export interface ReplaySaver {
  /** `download`: the browser saves it (a Blob download); `save`: the host asks where. */
  readonly kind: "download" | "save";
  save(file: ReplayFile): Promise<SaveOutcome>;
}

/**
 * The `ExportOptions` for the choices: only the options that are on, so with none chosen the
 * result is `{}` and `exportReplay` writes the plain export, byte for byte. Throws a
 * `RangeError` when rounding is on with a step core does not take.
 */
export function exportOptionsFrom(choices: ExportChoices): ExportOptions {
  if (choices.roundTimes && !isRoundTimesStep(choices.roundStep)) {
    throw new RangeError(EXPORT_TEXT.badStep);
  }
  return {
    ...(choices.opaqueNames ? { names: "opaque" as const } : {}),
    ...(choices.roundTimes ? { roundTimes: choices.roundStep } : {}),
    ...(choices.bucketTokens ? { bucketTokens: true } : {}),
  };
}

/**
 * Make the replay file for `model` with the chosen options, through core's `exportReplay`. Throws
 * what `exportReplay` throws (a `ReplayValidationError` for a model that does not validate) and
 * the `RangeError` of `exportOptionsFrom`.
 */
export function makeReplayFile(
  model: ReplayModel,
  choices: ExportChoices = DEFAULT_EXPORT_CHOICES,
): ReplayFile {
  const result = exportReplay(model, exportOptionsFrom(choices));
  return { fileName: result.fileName, data: result.data };
}

/** The parts of the page a Blob download uses: `document` and `URL` in the browser. */
export interface DownloadPage {
  readonly document: Pick<Document, "createElement" | "body">;
  readonly URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
}

/**
 * Save a replay file as a browser download: a Blob, an object URL and a link with `download`
 * that is clicked once and removed. The URL is revoked after the click has been handled. Whether
 * the browser then asks where to save is up to the browser, so this resolves with `downloaded`.
 */
export function downloadReplay(
  file: ReplayFile,
  page: DownloadPage = { document, URL },
): Promise<SaveOutcome> {
  const blob = new Blob([file.data], { type: "application/json" });
  const url = page.URL.createObjectURL(blob);
  try {
    const link = page.document.createElement("a");
    link.href = url;
    link.download = file.fileName;
    link.rel = "noopener";
    link.hidden = true;
    page.document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Revoked on a later task, so the download has started first.
    setTimeout(() => page.URL.revokeObjectURL(url), 0);
  }
  return Promise.resolve("downloaded");
}

/** The saver of a browser page. */
export const DOWNLOAD_SAVER: ReplaySaver = {
  kind: "download",
  save: (file) => downloadReplay(file),
};

/** What the polite live region says after an export. */
export function exportAnnouncement(outcome: SaveOutcome, fileName: string): string {
  switch (outcome) {
    case "saved":
      return `Replay saved as ${fileName}.`;
    case "downloaded":
      return `Replay downloaded as ${fileName}.`;
    case "cancelled":
      return "Export cancelled. No file was saved.";
  }
}

/** What the polite live region says when an export failed, with the host's or core's reason. */
export function exportFailedAnnouncement(reason: string): string {
  return `The replay could not be exported. ${reason}`;
}
