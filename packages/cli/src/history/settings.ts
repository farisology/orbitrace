/**
 * The history recording switch (#195): a small settings file in the data folder,
 * `<data folder>/settings.json`, `{ "settings": 1, "historyRecording": true | false }`, 0600.
 *
 * Since #211 the switch lives in `@orbitrace/core/node` (`history/settings.ts`), so this command
 * and the editor extension share one implementation and one file; this module passes it on under
 * the names the CLI uses.
 *
 * Recording is off when the file is missing (the default) and when it cannot be read or does not
 * have that shape. Only `orbitrace history enable` and `orbitrace history disable` write it, and
 * `disable` writes it only when it exists, so with recording off no command creates the file or
 * the folder.
 */

export {
  HISTORY_SETTINGS_FILE,
  HISTORY_SETTINGS_FORMAT,
  historySettingsFile,
  readHistorySettings,
  setHistoryRecording,
  writeHistorySettings,
  type HistorySettings,
  type HistorySettingsState,
  type HistorySwitchResult,
} from "@orbitrace/core/node";
