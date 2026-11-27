import { describe, expect, it } from "vitest";
import { installPromptSpies, splitMessageArgs, type PromptWindowLike } from "./prompt-spies.js";

/** A stand-in for `vscode.window` whose functions record that they were reached. */
function fakeWindow() {
  const reached: string[] = [];
  const channels: { name: string; lines: string[] }[] = [];
  const window = {
    showInformationMessage: () => reached.push("info"),
    showWarningMessage: () => reached.push("warning"),
    showErrorMessage: () => reached.push("error"),
    showQuickPick: () => reached.push("quickPick"),
    createOutputChannel(name: string) {
      const channel = {
        name,
        lines: [] as string[],
        appendLine: (line: string) => channel.lines.push(line),
      };
      channels.push(channel);
      return channel;
    },
  };
  return { window, reached, channels };
}

describe("splitMessageArgs", () => {
  it("separates the message, the options of a modal and the buttons", () => {
    expect(splitMessageArgs(["Turn on?", { modal: true, detail: "Why." }, "Turn on"])).toEqual({
      message: "Turn on?",
      modal: true,
      detail: "Why.",
      items: ["Turn on"],
    });
    expect(splitMessageArgs(["Done.", "Copy path"])).toEqual({
      message: "Done.",
      modal: false,
      detail: undefined,
      items: ["Copy path"],
    });
    expect(splitMessageArgs(["Plain."])).toMatchObject({ items: [] });
    // A button given as an object with a title is a button, not options.
    expect(splitMessageArgs(["Pick.", { title: "A" }])).toMatchObject({ items: [{ title: "A" }] });
  });
});

describe("installPromptSpies", () => {
  it("records every dialog, answers it as told and never reaches the real one", async () => {
    const { window, reached } = fakeWindow();
    const spies = installPromptSpies(window as unknown as PromptWindowLike);
    const w = window as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    expect(await w["showInformationMessage"]?.("Plain.")).toBeUndefined();
    spies.answer = (call) => (call.modal ? "Turn on" : undefined);
    expect(
      await w["showWarningMessage"]?.("Turn on?", { modal: true, detail: "Why." }, "Turn on"),
    ).toBe("Turn on");
    expect(await w["showErrorMessage"]?.("Failed.")).toBeUndefined();
    spies.pick = (items) => items[1];
    expect(await w["showQuickPick"]?.([{ key: "a" }, { key: "b" }], { title: "Choose" })).toEqual({
      key: "b",
    });
    expect(await w["showQuickPick"]?.(Promise.resolve([1]))).toBeUndefined();
    expect(reached).toEqual([]);
    expect(spies.calls.map((call) => call.kind)).toEqual([
      "info",
      "warning",
      "error",
      "quickPick",
      "quickPick",
    ]);
    expect(spies.callsOf("warning")[0]).toEqual({
      kind: "warning",
      message: "Turn on?",
      modal: true,
      detail: "Why.",
      items: ["Turn on"],
    });
    expect(spies.callsOf("quickPick")[0]?.message).toBe("Choose");
    spies.restore();
    (window as unknown as Record<string, () => void>)["showInformationMessage"]?.();
    expect(reached).toEqual(["info"]);
  });

  it("keeps the lines written to an output channel, which still works", () => {
    const { window, channels } = fakeWindow();
    const spies = installPromptSpies(window as unknown as PromptWindowLike);
    const channel = (
      window.createOutputChannel as (name: string) => { appendLine(l: string): void }
    )("Orbitrace");
    channel.appendLine("History: copied 1 new line.");
    expect(spies.output.get("Orbitrace")).toEqual(["History: copied 1 new line."]);
    expect(channels[0]?.lines).toEqual(["History: copied 1 new line."]);
    spies.restore();
    expect(window.createOutputChannel("Other")).toMatchObject({ name: "Other" });
    expect(spies.output.has("Other")).toBe(false);
  });
});
