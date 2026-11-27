// Making and saving an exported replay in the app (issue 168). Synthetic models only.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REPLAY_EXPORT_FILE_NAME,
  exportReplay,
  validateReplay,
  type ReplayModel,
} from "@orbitrace/core";
import {
  DEFAULT_EXPORT_CHOICES,
  DEFAULT_ROUND_STEP,
  DOWNLOAD_SAVER,
  EXPORT_TEXT,
  downloadReplay,
  exportAnnouncement,
  exportFailedAnnouncement,
  exportOptionsFrom,
  makeReplayFile,
  type DownloadPage,
} from "../src/export-replay";
import { DEMO, makeModel } from "./helpers";

const FILE_NAME = REPLAY_EXPORT_FILE_NAME;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("export choices", () => {
  it("are all off by default, with a tenth of a second ready as the step", () => {
    expect(DEFAULT_EXPORT_CHOICES).toEqual({
      opaqueNames: false,
      roundTimes: false,
      roundStep: 0.1,
      bucketTokens: false,
    });
    expect(DEFAULT_ROUND_STEP).toBe(0.1);
  });

  it("give no export option at all when none is on, so the bytes are the plain export", () => {
    expect(exportOptionsFrom(DEFAULT_EXPORT_CHOICES)).toEqual({});
    // A step typed while rounding is off is not passed.
    expect(exportOptionsFrom({ ...DEFAULT_EXPORT_CHOICES, roundStep: 5 })).toEqual({});
  });

  it("give core's option for each one that is on", () => {
    expect(exportOptionsFrom({ ...DEFAULT_EXPORT_CHOICES, opaqueNames: true })).toEqual({
      names: "opaque",
    });
    expect(
      exportOptionsFrom({ ...DEFAULT_EXPORT_CHOICES, roundTimes: true, roundStep: 0.25 }),
    ).toEqual({ roundTimes: 0.25 });
    expect(exportOptionsFrom({ ...DEFAULT_EXPORT_CHOICES, bucketTokens: true })).toEqual({
      bucketTokens: true,
    });
    expect(
      exportOptionsFrom({ opaqueNames: true, roundTimes: true, roundStep: 1, bucketTokens: true }),
    ).toEqual({ names: "opaque", roundTimes: 1, bucketTokens: true });
  });

  it("refuse a step core does not take", () => {
    for (const roundStep of [0, 0.0005, 1 / 3, 3601, Number.NaN]) {
      expect(() =>
        exportOptionsFrom({ ...DEFAULT_EXPORT_CHOICES, roundTimes: true, roundStep }),
      ).toThrow(new RangeError(EXPORT_TEXT.badStep));
    }
  });
});

describe("makeReplayFile", () => {
  it("is core's exportReplay with no option: the same bytes and the name core gives", () => {
    const file = makeReplayFile(DEMO, DEFAULT_EXPORT_CHOICES);
    expect(file).toEqual({ fileName: FILE_NAME, data: exportReplay(DEMO).data });
    expect(file.fileName).toBe("orbitrace.replay.json");
    expect(file.fileName.endsWith(".replay.json")).toBe(true);
    expect(validateReplay(JSON.parse(file.data))).toBe(true);
    expect(file.data.endsWith("\n")).toBe(true);
  });

  it("passes the chosen options to exportReplay", () => {
    const choices = { opaqueNames: true, roundTimes: true, roundStep: 0.5, bucketTokens: true };
    const file = makeReplayFile(DEMO, choices);
    expect(file.data).toBe(
      exportReplay(DEMO, { names: "opaque", roundTimes: 0.5, bucketTokens: true }).data,
    );
    expect(file.data).not.toBe(exportReplay(DEMO).data);
    expect(validateReplay(JSON.parse(file.data))).toBe(true);
  });

  it("goes through the allow-list: a property the app added to its model is never written", () => {
    const model = makeModel();
    const extended = {
      ...model,
      appOnly: "example-note",
      agents: model.agents.map((agent) => ({ ...agent, appOnly: "example-note" })),
    } as unknown as ReplayModel;
    const file = makeReplayFile(extended, DEFAULT_EXPORT_CHOICES);
    expect(file.data).not.toContain("appOnly");
    expect(file.data).toBe(exportReplay(model).data);
    expect(file.data).not.toBe(`${JSON.stringify(extended)}\n`);
  });

  it("throws core's validation error for a model that does not validate", () => {
    const broken = { ...makeModel(), formatVersion: 99 } as unknown as ReplayModel;
    expect(() => makeReplayFile(broken, DEFAULT_EXPORT_CHOICES)).toThrow(
      expect.objectContaining({ name: "ReplayValidationError" }),
    );
  });

  it("defaults to every option off", () => {
    expect(makeReplayFile(DEMO)).toEqual({ fileName: FILE_NAME, data: exportReplay(DEMO).data });
  });
});

describe("downloadReplay", () => {
  function fakePage() {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const clicks: { href: string; download: string; inPage: boolean }[] = [];
    const page: DownloadPage = {
      document: {
        body: document.body,
        createElement: ((tag: string) => {
          const element = document.createElement(tag);
          if (element instanceof HTMLAnchorElement) {
            element.click = () =>
              clicks.push({
                href: element.href,
                download: element.download,
                inPage: document.body.contains(element),
              });
          }
          return element;
        }) as Document["createElement"],
      },
      URL: {
        createObjectURL: (blob: Blob) => {
          created.push(blob);
          return "blob:synthetic-download";
        },
        revokeObjectURL: (url: string) => {
          revoked.push(url);
        },
      },
    };
    return { page, created, revoked, clicks };
  }

  it("downloads a JSON Blob of exactly the file's text under its name, then cleans up", async () => {
    vi.useFakeTimers();
    const { page, created, revoked, clicks } = fakePage();
    const data = exportReplay(DEMO).data;
    await expect(downloadReplay({ fileName: FILE_NAME, data }, page)).resolves.toBe("downloaded");
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("application/json");
    expect(await created[0]?.text()).toBe(data);
    expect(clicks).toEqual([
      { href: "blob:synthetic-download", download: FILE_NAME, inPage: true },
    ]);
    // The link is gone; the URL is revoked once the click has been handled.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(["blob:synthetic-download"]);
  });

  it("is the saver of a browser page", async () => {
    expect(DOWNLOAD_SAVER.kind).toBe("download");
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-saver");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await expect(DOWNLOAD_SAVER.save({ fileName: FILE_NAME, data: "{}\n" })).resolves.toBe(
      "downloaded",
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("export announcements", () => {
  it("say what happened, with the file name where a file was written", () => {
    expect(exportAnnouncement("saved", FILE_NAME)).toBe(`Replay saved as ${FILE_NAME}.`);
    expect(exportAnnouncement("downloaded", FILE_NAME)).toBe(`Replay downloaded as ${FILE_NAME}.`);
    expect(exportAnnouncement("cancelled", FILE_NAME)).toBe("Export cancelled. No file was saved.");
    expect(exportFailedAnnouncement("The disk is full.")).toBe(
      "The replay could not be exported. The disk is full.",
    );
  });
});

describe("export wording", () => {
  it("says what a replay holds and never holds", () => {
    expect(EXPORT_TEXT.contains).toMatch(/structure/);
    expect(EXPORT_TEXT.contains).toMatch(/names/);
    expect(EXPORT_TEXT.contains).toMatch(/timings/);
    expect(EXPORT_TEXT.contains).toMatch(/token counts/);
    expect(EXPORT_TEXT.contains).toMatch(/never holds prompts.*tool output/);
  });

  it("says for each option what it hides and what it does not", () => {
    expect(EXPORT_TEXT.opaqueNamesHelp).toMatch(/Replaces .* It does not hide/);
    expect(EXPORT_TEXT.roundTimesHelp).toMatch(/hides exact times\. The order .* stay/);
    expect(EXPORT_TEXT.bucketTokensHelp).toMatch(/hides exact sizes, not rough ones/);
  });
});
