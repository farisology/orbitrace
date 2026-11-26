import { describe, expect, it } from "vitest";
import {
  PROJECT_FOLDER_MAX_LENGTH,
  encodeProjectFolder,
  folderMatchesWorkspace,
  projectFolderOfLocator,
  sessionInWorkspace,
  trimTrailingSeparators,
} from "../src/workspace-match.js";
import { makeRef, makeSummary } from "./helpers.js";

describe("trimTrailingSeparators", () => {
  it("drops trailing separators but keeps a bare root", () => {
    expect(trimTrailingSeparators("/workspace/kite/")).toBe("/workspace/kite");
    expect(trimTrailingSeparators("/workspace/kite//")).toBe("/workspace/kite");
    expect(trimTrailingSeparators("D:\\work\\kite\\")).toBe("D:\\work\\kite");
    expect(trimTrailingSeparators("/")).toBe("/");
    expect(trimTrailingSeparators("D:\\")).toBe("D:\\");
  });
});

describe("encodeProjectFolder", () => {
  it("replaces every character that is not an ASCII letter or digit with a dash", () => {
    expect(encodeProjectFolder("/workspace/kite-workshop")).toBe("-workspace-kite-workshop");
    expect(encodeProjectFolder("/workspace/my app.v2/")).toBe("-workspace-my-app-v2");
    expect(encodeProjectFolder("D:\\work\\kite")).toBe("D--work-kite");
    expect(encodeProjectFolder("/workspace/café")).toBe("-workspace-caf-");
  });
});

describe("projectFolderOfLocator", () => {
  it("returns the folder that holds the main transcript", () => {
    expect(projectFolderOfLocator("/workspace/.cfg/projects/-workspace-kite/abc.jsonl")).toBe(
      "-workspace-kite",
    );
    expect(projectFolderOfLocator("D:\\cfg\\projects\\D--work-kite\\abc.jsonl")).toBe(
      "D--work-kite",
    );
  });

  it("returns null for a locator without the transcript shape", () => {
    expect(projectFolderOfLocator("/workspace/.cfg/projects/-workspace-kite/abc.json")).toBeNull();
    expect(projectFolderOfLocator("abc.jsonl")).toBeNull();
  });
});

describe("folderMatchesWorkspace", () => {
  it("matches the folder name written for the workspace path", () => {
    expect(folderMatchesWorkspace("-workspace-kite-workshop", "/workspace/kite-workshop")).toBe(
      true,
    );
    expect(folderMatchesWorkspace("-workspace-kite-workshop", "/workspace/kite-workshop/")).toBe(
      true,
    );
    expect(folderMatchesWorkspace("-workspace-kite-workshop", "/workspace/kite")).toBe(false);
  });

  it("does not match a session started in a subfolder", () => {
    expect(folderMatchesWorkspace("-workspace-kite-workshop-src", "/workspace/kite-workshop")).toBe(
      false,
    );
  });

  it("ignores case for Windows paths only", () => {
    expect(folderMatchesWorkspace("D--work-kite", "d:\\work\\kite")).toBe(true);
    expect(folderMatchesWorkspace("-workspace-Kite", "/workspace/kite")).toBe(false);
  });

  it("matches a cut name by its first 200 characters", () => {
    const long = `/workspace/${"deep/".repeat(60)}kite`;
    const encoded = encodeProjectFolder(long);
    expect(encoded.length).toBeGreaterThan(PROJECT_FOLDER_MAX_LENGTH);
    const cut = `${encoded.slice(0, PROJECT_FOLDER_MAX_LENGTH)}-1a2b3c`;
    expect(folderMatchesWorkspace(cut, long)).toBe(true);
    expect(folderMatchesWorkspace(cut, "/workspace/kite")).toBe(false);
  });

  it("never matches an empty workspace path", () => {
    expect(folderMatchesWorkspace("", "")).toBe(false);
    expect(folderMatchesWorkspace("-", "  ")).toBe(false);
  });
});

describe("sessionInWorkspace", () => {
  const ref = makeRef(makeSummary(), "-workspace-kite-workshop");

  it("is true when any workspace folder matches", () => {
    expect(sessionInWorkspace(ref, ["/workspace/other", "/workspace/kite-workshop"])).toBe(true);
    expect(sessionInWorkspace(ref, ["/workspace/other"])).toBe(false);
    expect(sessionInWorkspace(ref, [])).toBe(false);
  });

  it("is false for a locator without the transcript shape", () => {
    expect(
      sessionInWorkspace({ ...ref, locator: "not-a-transcript" }, ["/workspace/kite-workshop"]),
    ).toBe(false);
  });
});
