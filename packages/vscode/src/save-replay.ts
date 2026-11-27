/**
 * Saving an exported replay from an editor tab (#168), vscode glue. The message host has already
 * checked the text (shape, size, `validateReplay`) and written it again through `exportReplay`;
 * this asks the user where to save it with the editor's own save dialog and writes it there.
 *
 * The suggested name is the one core's `exportReplay` gives (`REPLAY_EXPORT_FILE_NAME`,
 * `orbitrace.replay.json`), in the first workspace folder or the home folder. It never names a
 * session or a project. The webview never chooses the path or the name: only the user does, in
 * the dialog.
 */

import { homedir } from "node:os";
import * as vscode from "vscode";
import { REPLAY_EXPORT_FILE_NAME, type SaveReplayOutcome } from "@orbitrace/core";

/** The words of the save dialog. */
export const SAVE_DIALOG_TEXT = {
  title: "Save Orbitrace replay",
  saveLabel: "Save replay",
  filter: "Orbitrace replay",
} as const;

/** The folder the save dialog opens in: the first local workspace folder, else the home folder. */
export function defaultSaveFolder(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.find((entry) => entry.uri.scheme === "file");
  return vscode.Uri.file(folder?.uri.fsPath ?? homedir());
}

/**
 * Ask where to save `data` and write it there as UTF-8. Resolves `cancelled` when the user closes
 * the dialog, `saved` once the file is written; rejects when writing fails.
 */
export async function saveReplayWithDialog(data: string): Promise<SaveReplayOutcome> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(defaultSaveFolder(), REPLAY_EXPORT_FILE_NAME),
    filters: { [SAVE_DIALOG_TEXT.filter]: ["json"] },
    saveLabel: SAVE_DIALOG_TEXT.saveLabel,
    title: SAVE_DIALOG_TEXT.title,
  });
  if (target === undefined) return "cancelled";
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(data));
  return "saved";
}
