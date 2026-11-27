// The editor's save dialog for an exported replay (#168), against the vscode fake. Synthetic
// paths and values only.
import { homedir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { REPLAY_EXPORT_FILE_NAME } from "@orbitrace/core";
import { SAVE_DIALOG_TEXT, defaultSaveFolder, saveReplayWithDialog } from "../src/save-replay.js";
import { fake, workspace } from "./fakes/vscode.js";

const NAME = REPLAY_EXPORT_FILE_NAME;
const DATA = '{"formatVersion":1}\n';

beforeEach(() => {
  fake.reset();
});

describe("defaultSaveFolder", () => {
  it("is the first local workspace folder", () => {
    workspace.workspaceFolders = [
      { uri: { scheme: "vscode-remote", fsPath: "/remote/example" }, name: "remote", index: 0 },
      { uri: { scheme: "file", fsPath: "/workspace/example-project" }, name: "local", index: 1 },
    ];
    expect(defaultSaveFolder().fsPath).toBe("/workspace/example-project");
  });

  it("is the home folder without one", () => {
    expect(defaultSaveFolder().fsPath).toBe(homedir());
  });
});

describe("saveReplayWithDialog", () => {
  it("suggests the name exportReplay gives, asks where, and writes the text there", async () => {
    workspace.workspaceFolders = [
      { uri: { scheme: "file", fsPath: "/workspace/example-project" }, name: "w", index: 0 },
    ];
    const target = vscode.Uri.file("/workspace/example-project/chosen.json");
    fake.saveDialog = () => target;
    await expect(saveReplayWithDialog(DATA)).resolves.toBe("saved");
    expect(fake.saveDialogCalls).toHaveLength(1);
    const options = fake.saveDialogCalls[0];
    expect(options?.defaultUri?.fsPath).toBe(`/workspace/example-project/${NAME}`);
    expect(options?.filters).toEqual({ [SAVE_DIALOG_TEXT.filter]: ["json"] });
    expect(options?.saveLabel).toBe(SAVE_DIALOG_TEXT.saveLabel);
    expect(options?.title).toBe(SAVE_DIALOG_TEXT.title);
    const written = fake.written.get(target.toString());
    expect(new TextDecoder().decode(written)).toBe(DATA);
  });

  it("writes nothing when the user closes the dialog", async () => {
    await expect(saveReplayWithDialog(DATA)).resolves.toBe("cancelled");
    expect(fake.written.size).toBe(0);
  });

  it("rejects when the file cannot be written", async () => {
    fake.saveDialog = () => vscode.Uri.file("/workspace/read-only/x.json");
    fake.writeError = new Error("synthetic write failure");
    await expect(saveReplayWithDialog(DATA)).rejects.toThrow("synthetic write failure");
  });

  it("suggests orbitrace.replay.json, the contract's .replay.json name", async () => {
    await saveReplayWithDialog(DATA);
    expect(fake.saveDialogCalls[0]?.defaultUri?.path).toMatch(/\/orbitrace\.replay\.json$/);
  });
});
