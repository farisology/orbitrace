/**
 * The history recording switch (#195): a small settings file in the data folder,
 * `<data folder>/settings.json`, `{ "settings": 1, "historyRecording": true | false }`, 0600.
 *
 * Recording is off when the file is missing (the default) and when it cannot be read or does not
 * have that shape. Only `orbitrace history enable` and `orbitrace history disable` write it, and
 * `disable` writes it only when it exists, so with recording off no command creates the file or
 * the folder.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  checkHistoryLocation,
  HISTORY_FILE_MODE,
  HistoryStoreError,
  pathApiFor,
  prepareHistoryDir,
  type HistoryLocation,
  type HistoryLocationOptions,
} from "@orbitrace/core/node";

/** The settings file in the data folder. */
export const HISTORY_SETTINGS_FILE = "settings.json";

/** The version of the settings file's shape. */
export const HISTORY_SETTINGS_FORMAT = 1;

/** `missing`: no file (recording off). `ok`: read. `invalid`: there but not readable (off). */
export type HistorySettingsState = "missing" | "ok" | "invalid";

export interface HistorySettings {
  readonly state: HistorySettingsState;
  /** Whether recording is on. False unless the file is `ok` and says so. */
  readonly recording: boolean;
}

/** The settings file of a data folder. */
export function historySettingsFile(location: HistoryLocation, platform: string): string {
  return pathApiFor(platform).join(location.dir, HISTORY_SETTINGS_FILE);
}

/** Read the settings file. Never throws and never writes. */
export function readHistorySettings(file: string): HistorySettings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { state: code === "ENOENT" ? "missing" : "invalid", recording: false };
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { settings?: unknown }).settings === HISTORY_SETTINGS_FORMAT &&
      typeof (value as { historyRecording?: unknown }).historyRecording === "boolean"
    ) {
      return { state: "ok", recording: (value as { historyRecording: boolean }).historyRecording };
    }
  } catch {
    // Not JSON.
  }
  return { state: "invalid", recording: false };
}

/**
 * Write the settings file: check the folder is allowed (not inside a git working tree or a Claude
 * Code config folder), create it (0700) when missing, then write the file (0600) through a
 * temporary file and a rename, so a reader never sees half a file. Throws a `HistoryStoreError`
 * (`unsafe-location`, `io`) whose message names no path.
 */
export function writeHistorySettings(
  location: HistoryLocation,
  options: HistoryLocationOptions & { readonly platform: string },
  recording: boolean,
): void {
  checkHistoryLocation(location, options);
  prepareHistoryDir(location);
  const file = historySettingsFile(location, options.platform);
  const temp = `${file}.${process.pid}.tmp`;
  const text = `${JSON.stringify({ settings: HISTORY_SETTINGS_FORMAT, historyRecording: recording })}\n`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode: HISTORY_FILE_MODE });
    chmodSync(temp, HISTORY_FILE_MODE);
    renameSync(temp, file);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Not there.
    }
    throw new HistoryStoreError("io", "The history settings file could not be written.");
  }
}
