// The Export button and dialog in the app (issue 168), against a fake host and a fake saver.
// Every value is invented.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportReplay, type ReplayModel } from "@orbitrace/core";
import { App, APP_MESSAGES, EXPORT_STATUS, exportFailureReason } from "../src/App";
import { ExportDialog, parseRoundStep } from "../src/components/ExportDialog";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { createDemoTransport } from "../src/demo-session";
import {
  EXPORT_TEXT,
  exportAnnouncement,
  exportFailedAnnouncement,
  type ReplayFile,
  type ReplaySaver,
  type SaveOutcome,
} from "../src/export-replay";
import type { HostTransport } from "../src/transport";
import { NO_START_OPTIONS } from "../src/url-state";
import { DEMO, fakeOrrery, makeModel, replayUpdate, scriptedHost, stillFrames } from "./helpers";

interface FakeSaver extends ReplaySaver {
  readonly files: ReplayFile[];
}

function fakeSaver(
  answer: (file: ReplayFile) => Promise<SaveOutcome> = async () => "downloaded",
  kind: ReplaySaver["kind"] = "download",
): FakeSaver {
  const files: ReplayFile[] = [];
  return {
    kind,
    files,
    save: vi.fn((file: ReplayFile) => {
      files.push(file);
      return answer(file);
    }),
  };
}

function renderApp(transport: HostTransport, saver?: ReplaySaver) {
  const orrery = fakeOrrery();
  return render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <App
        transport={transport}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, paused: true }}
        {...(saver !== undefined ? { saver } : {})}
      />
    </OrreryFactoryContext.Provider>,
  );
}

const exportButton = () => screen.getByRole("button", { name: EXPORT_TEXT.button });
const dialog = () => screen.getByRole("dialog", { name: EXPORT_TEXT.title });
const politeRegion = () => document.querySelector('[aria-live="polite"]') as HTMLElement;
const option = (name: string) =>
  within(dialog()).getByRole("checkbox", { name }) as HTMLInputElement;
const stepInput = () =>
  within(dialog()).getByRole("spinbutton", { name: EXPORT_TEXT.roundStep }) as HTMLInputElement;

async function openDemo(saver: ReplaySaver) {
  renderApp(createDemoTransport(), saver);
  await screen.findByRole("list", { name: "Agents" });
  fireEvent.click(exportButton());
  return dialog();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Export button", () => {
  it("is in the header when the host can save, and not before a replay is shown", async () => {
    renderApp(createDemoTransport(), fakeSaver());
    expect(screen.queryByRole("button", { name: EXPORT_TEXT.button })).toBeNull();
    await screen.findByRole("list", { name: "Agents" });
    const button = exportButton();
    expect(button.closest("header")).not.toBeNull();
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not there without a saver (the public player, an editor tab with no host)", async () => {
    renderApp(createDemoTransport());
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.queryByRole("button", { name: EXPORT_TEXT.button })).toBeNull();
  });
});

describe("the export dialog", () => {
  it("offers the three options, all off, each saying what it hides and what it does not", async () => {
    const view = await openDemo(fakeSaver());
    expect(view.getAttribute("aria-describedby")).not.toBeNull();
    expect(within(view).getByText(EXPORT_TEXT.contains)).toBeDefined();
    expect(within(view).getByRole("group", { name: EXPORT_TEXT.optionsLegend })).toBeDefined();
    for (const [name, help] of [
      [EXPORT_TEXT.opaqueNames, EXPORT_TEXT.opaqueNamesHelp],
      [EXPORT_TEXT.roundTimes, EXPORT_TEXT.roundTimesHelp],
      [EXPORT_TEXT.bucketTokens, EXPORT_TEXT.bucketTokensHelp],
    ] as const) {
      const box = option(name);
      expect(box.checked).toBe(false);
      const helpId = box.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(helpId)?.textContent).toBe(help);
    }
    expect(stepInput().disabled).toBe(true);
    expect(stepInput().value).toBe("0.1");
    expect(within(view).getByText(EXPORT_TEXT.structure)).toBeDefined();
    expect(within(view).getByText(EXPORT_TEXT.checkNames)).toBeDefined();
    // A replay that is not live says nothing about a snapshot.
    expect(within(view).queryByText(EXPORT_TEXT.live)).toBeNull();
    expect(within(view).getByRole("button", { name: EXPORT_TEXT.download })).toBeDefined();
  });

  it("with no option chosen, writes exactly core's plain export and says it was downloaded", async () => {
    const saver = fakeSaver();
    await openDemo(saver);
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.download }));
    await waitFor(() => expect(saver.files).toHaveLength(1));
    const file = saver.files[0] as ReplayFile;
    expect(file.data).toBe(exportReplay(DEMO).data);
    expect(file.fileName).toBe("orbitrace.replay.json");
    await waitFor(() =>
      expect(politeRegion().textContent).toBe(exportAnnouncement("downloaded", file.fileName)),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(EXPORT_STATUS.downloaded)).toBeDefined();
    expect(document.activeElement).toBe(exportButton());
  });

  it("with every option chosen, passes them all to exportReplay", async () => {
    const saver = fakeSaver();
    await openDemo(saver);
    fireEvent.click(option(EXPORT_TEXT.opaqueNames));
    fireEvent.click(option(EXPORT_TEXT.roundTimes));
    expect(stepInput().disabled).toBe(false);
    fireEvent.change(stepInput(), { target: { value: "0.5" } });
    fireEvent.click(option(EXPORT_TEXT.bucketTokens));
    // Opaque names replaces the reminder to check the names.
    expect(within(dialog()).queryByText(EXPORT_TEXT.checkNames)).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.download }));
    await waitFor(() => expect(saver.files).toHaveLength(1));
    expect(saver.files[0]?.data).toBe(
      exportReplay(DEMO, { names: "opaque", roundTimes: 0.5, bucketTokens: true }).data,
    );
  });

  it("starts with every option off again the next time it opens", async () => {
    const saver = fakeSaver();
    await openDemo(saver);
    fireEvent.click(option(EXPORT_TEXT.opaqueNames));
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.cancel }));
    fireEvent.click(exportButton());
    expect(option(EXPORT_TEXT.opaqueNames).checked).toBe(false);
  });

  it("refuses a step core does not take, says why and keeps the dialog open", async () => {
    const saver = fakeSaver();
    await openDemo(saver);
    fireEvent.click(option(EXPORT_TEXT.roundTimes));
    fireEvent.change(stepInput(), { target: { value: "0.0005" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.download }));
    expect(saver.files).toHaveLength(0);
    expect(stepInput().getAttribute("aria-invalid")).toBe("true");
    const errorId = stepInput().getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(errorId)?.textContent).toBe(EXPORT_TEXT.badStep);
    expect(document.activeElement).toBe(stepInput());
    // Typing clears the error.
    fireEvent.change(stepInput(), { target: { value: "1" } });
    expect(stepInput().getAttribute("aria-invalid")).toBeNull();
  });

  it("closes on Cancel and on Escape without saving, and gives focus back to Export", async () => {
    const saver = fakeSaver();
    await openDemo(saver);
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(exportButton());
    fireEvent.click(exportButton());
    // The browser fires `cancel` on the dialog when Escape is pressed.
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(exportButton());
    expect(saver.save).not.toHaveBeenCalled();
  });

  it("is closed while still in the document, so the browser can put focus back", async () => {
    // A browser restores focus only when `close()` runs on a dialog that is still connected and
    // modal; on a node React has already removed it restores nothing.
    const connectedAtClose: boolean[] = [];
    const realClose = HTMLDialogElement.prototype.close;
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
      this: HTMLDialogElement,
      ...args: Parameters<HTMLDialogElement["close"]>
    ) {
      connectedAtClose.push(this.isConnected);
      realClose.apply(this, args);
    });
    const saver = fakeSaver();
    await openDemo(saver);
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.cancel }));
    fireEvent.click(exportButton());
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    fireEvent.click(exportButton());
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.download }));
    await waitFor(() => expect(saver.files).toHaveLength(1));
    expect(connectedAtClose).toEqual([true, true, true]);
  });

  it("gives focus back to Export on every close even though the page is inert while it is open", async () => {
    // happy-dom has no inertness: make every element outside an open dialog refuse focus, as a
    // browser does while a modal dialog is open.
    const realFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      ...args: Parameters<HTMLElement["focus"]>
    ) {
      const open = document.querySelector("dialog[open]");
      if (open !== null && !open.contains(this)) return;
      realFocus.apply(this, args);
    });
    const saver = fakeSaver();
    await openDemo(saver);
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(exportButton());
    fireEvent.click(exportButton());
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(exportButton());
    fireEvent.click(exportButton());
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.download }));
    await waitFor(() => expect(saver.files).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(exportButton());
  });

  it("keeps keys pressed inside it away from the playback keys", async () => {
    await openDemo(fakeSaver());
    const play = screen.getByRole("button", { name: /^(Play|Pause)$/ });
    const before = play.textContent;
    fireEvent.keyDown(option(EXPORT_TEXT.opaqueNames), { key: "ArrowRight" });
    fireEvent.keyDown(dialog(), { key: " " });
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(play.textContent).toBe(before);
    expect(
      (screen.getByRole("slider", { name: "Replay position" }) as HTMLInputElement).value,
    ).toBe("0");
  });

  it("names the button Save in the editor, where the host asks where to save", async () => {
    const saver = fakeSaver(async () => "saved", "save");
    await openDemo(saver);
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.save }));
    await waitFor(() => expect(politeRegion().textContent).toMatch(/^Replay saved as /));
    expect(screen.getByText(EXPORT_STATUS.saved)).toBeDefined();
  });

  it("says when the user cancelled the host's save dialog", async () => {
    await openDemo(fakeSaver(async () => "cancelled", "save"));
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.save }));
    await waitFor(() =>
      expect(politeRegion().textContent).toBe(exportAnnouncement("cancelled", "")),
    );
    expect(screen.getByText(EXPORT_STATUS.cancelled)).toBeDefined();
  });

  it("announces the same result again: cancelled twice is said twice", async () => {
    const saver = fakeSaver(async () => "cancelled", "save");
    await openDemo(saver);
    const message = exportAnnouncement("cancelled", "");
    for (let round = 1; round <= 2; round += 1) {
      if (round > 1) fireEvent.click(exportButton());
      // Empty while the dialog is open, so the result is a change to the live region.
      expect(politeRegion().textContent).toBe("");
      fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.save }));
      await waitFor(() => expect(politeRegion().textContent).toBe(message));
      expect(saver.files).toHaveLength(round);
    }
  });

  it("announces a retry that fails for the same reason", async () => {
    const reason = "The replay file could not be written.";
    const saver = fakeSaver(() => Promise.reject({ code: "internal", message: reason }), "save");
    await openDemo(saver);
    for (let round = 1; round <= 2; round += 1) {
      if (round > 1) fireEvent.click(exportButton());
      expect(politeRegion().textContent).toBe("");
      fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.save }));
      await waitFor(() =>
        expect(politeRegion().textContent).toBe(exportFailedAnnouncement(reason)),
      );
      expect(saver.files).toHaveLength(round);
    }
  });

  it("says when saving failed, with the host's reason, shown until dismissed", async () => {
    const reason = "The replay file could not be written.";
    await openDemo(fakeSaver(() => Promise.reject({ code: "internal", message: reason }), "save"));
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.save }));
    await waitFor(() => expect(politeRegion().textContent).toBe(exportFailedAnnouncement(reason)));
    expect(screen.getByText(EXPORT_STATUS.failed)).toBeDefined();
    const alert = document.querySelector(".alert") as HTMLElement;
    expect(alert.textContent).toContain(exportFailedAnnouncement(reason));
    // Not a second live region: the polite one has said it.
    expect(alert.getAttribute("role")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector(".alert")).toBeNull();
    expect(document.activeElement).toBe(exportButton());
  });
});

describe("exporting a live session", () => {
  it("says the file is a snapshot, and writes the snapshot shown at that moment", async () => {
    const host = scriptedHost();
    const saver = fakeSaver();
    renderApp(host, saver);
    await vi.waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
    const first = makeModel(60);
    const later = makeModel(90);
    act(() => host.push(replayUpdate(first, "busy")));
    act(() => host.push(replayUpdate(later, "busy")));
    fireEvent.click(exportButton());
    expect(within(dialog()).getByText(EXPORT_TEXT.live)).toBeDefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.download }));
    await waitFor(() => expect(saver.files).toHaveLength(1));
    expect(saver.files[0]?.data).toBe(exportReplay(later).data);
    // A snapshot after the export does not change the file that was made.
    act(() => host.push(replayUpdate(makeModel(120), "busy")));
    expect(saver.files).toHaveLength(1);
  });
});

describe("exportFailureReason", () => {
  it("uses a host's message, core's first problem, a range error's text or a fixed text", () => {
    expect(exportFailureReason({ code: "invalid", message: "Too large." })).toBe("Too large.");
    expect(exportFailureReason(new RangeError(EXPORT_TEXT.badStep))).toBe(EXPORT_TEXT.badStep);
    let invalid: unknown;
    try {
      exportReplay({ ...makeModel(), formatVersion: 99 } as unknown as ReplayModel);
    } catch (error) {
      invalid = error;
    }
    expect(exportFailureReason(invalid)).toMatch(
      new RegExp(`^${APP_MESSAGES.exportInvalid.replace(/\./g, "\\.")} \\S`),
    );
    expect(exportFailureReason(new Error("/private/path/not-shown"))).toBe(
      APP_MESSAGES.exportFailed,
    );
    expect(exportFailureReason("odd")).toBe(APP_MESSAGES.exportFailed);
  });

  it("is said when the replay on screen cannot be exported", async () => {
    const host = scriptedHost();
    const saver = fakeSaver();
    renderApp(host, saver);
    await vi.waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
    // The app shows what its host sent; export checks it again and refuses this one.
    const broken = { ...makeModel(), formatVersion: 99 } as unknown as ReplayModel;
    act(() => host.push(replayUpdate(broken, "ended")));
    fireEvent.click(exportButton());
    fireEvent.click(within(dialog()).getByRole("button", { name: EXPORT_TEXT.download }));
    expect(saver.save).not.toHaveBeenCalled();
    expect(politeRegion().textContent).toMatch(/^The replay could not be exported\. The replay/);
  });
});

describe("ExportDialog on its own", () => {
  it("reads a typed step as a number core takes, or null", () => {
    expect(parseRoundStep("0.1")).toBe(0.1);
    expect(parseRoundStep(" 5 ")).toBe(5);
    for (const text of ["", " ", "abc", "0", "-1", "0.0005", "3601", "1e9"]) {
      expect(parseRoundStep(text)).toBeNull();
    }
  });

  it("works where the browser has no modal dialog", () => {
    const showModal = HTMLDialogElement.prototype.showModal;
    const close = HTMLDialogElement.prototype.close;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      value: undefined,
      configurable: true,
    });
    try {
      const onExport = vi.fn();
      const view = render(
        <ExportDialog live saverKind="save" onCancel={() => {}} onExport={onExport} />,
      );
      const element = view.container.querySelector("dialog") as HTMLDialogElement;
      expect(element.hasAttribute("open")).toBe(true);
      expect(within(element).getByText(EXPORT_TEXT.live)).toBeDefined();
      fireEvent.click(within(element).getByRole("button", { name: EXPORT_TEXT.save }));
      expect(onExport).toHaveBeenCalledWith({
        opaqueNames: false,
        roundTimes: false,
        roundStep: 0.1,
        bucketTokens: false,
      });
      view.unmount();
      expect(element.hasAttribute("open")).toBe(false);
    } finally {
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
        value: showModal,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(HTMLDialogElement.prototype, "close", {
        value: close,
        configurable: true,
        writable: true,
      });
    }
  });
});
