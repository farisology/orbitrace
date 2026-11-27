// Tests for scripts/release/version.mjs and changelog.mjs. Every file is written into a
// temporary folder that the test removes; the repository's own files are only read.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANGE_TYPES,
  compareVersions,
  parseChangelog,
  releaseChangelog,
  run as runChangelog,
  sectionNotes,
  validateChangelog,
} from "./changelog.mjs";
import { REPO_ROOT } from "./lib.mjs";
import {
  bumpManifests,
  isValidVersion,
  readManifests,
  run as runVersion,
  sharedVersion,
  versionProblems,
} from "./version.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbitrace-version-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a synthetic packages/ folder: a library, an app that depends on it, and a tool. */
function writeWorkspace(root, version = "0.1.0") {
  const manifests = {
    lib: { name: "@synthetic/lib", version, private: false },
    app: {
      name: "@synthetic/app",
      version,
      dependencies: { "@synthetic/lib": version, react: "^19.0.0" },
      devDependencies: { "@synthetic/tool": version },
    },
    tool: { name: "@synthetic/tool", version, private: true },
  };
  for (const [dirName, manifest] of Object.entries(manifests)) {
    mkdirSync(join(root, "packages", dirName), { recursive: true });
    writeFileSync(
      join(root, "packages", dirName, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}

describe("isValidVersion", () => {
  it("accepts semantic versions and rejects everything else", () => {
    for (const good of ["0.0.0", "0.1.0", "1.2.3", "1.0.0-rc.1", "1.0.0-alpha.beta+build.7"]) {
      expect(isValidVersion(good)).toBe(true);
    }
    for (const bad of [
      "v0.1.0",
      "1.2",
      "01.2.3",
      "1.2.3 ",
      "1.2.3\n::error::x",
      "",
      "1.2.3;rm",
      1,
    ]) {
      expect(isValidVersion(bad)).toBe(false);
    }
  });
});

describe("version rules", () => {
  it("reads every package manifest, sorted by folder", () => {
    writeWorkspace(dir);
    expect(readManifests(dir).map((entry) => entry.dir)).toEqual(["app", "lib", "tool"]);
  });

  it("finds no problem when every package and internal dependency has the version", () => {
    writeWorkspace(dir);
    const manifests = readManifests(dir);
    expect(versionProblems(manifests, "0.1.0")).toEqual([]);
    expect(sharedVersion(manifests)).toBe("0.1.0");
  });

  it("lists each package and internal dependency on another version, but not external ones", () => {
    writeWorkspace(dir);
    const problems = versionProblems(readManifests(dir), "0.2.0");
    expect(problems).toEqual([
      "packages/app: version is 0.1.0, expected 0.2.0",
      "packages/app: dependencies.@synthetic/lib is 0.1.0, expected 0.2.0",
      "packages/app: devDependencies.@synthetic/tool is 0.1.0, expected 0.2.0",
      "packages/lib: version is 0.1.0, expected 0.2.0",
      "packages/tool: version is 0.1.0, expected 0.2.0",
    ]);
  });

  it("has no shared version when the packages disagree", () => {
    writeWorkspace(dir);
    const manifests = readManifests(dir);
    manifests[1].manifest.version = "9.9.9";
    expect(sharedVersion(manifests)).toBeNull();
  });

  it("bumps every version and internal dependency without changing the input", () => {
    writeWorkspace(dir);
    const manifests = readManifests(dir);
    const bumped = bumpManifests(manifests, "0.2.0");
    expect(versionProblems(bumped, "0.2.0")).toEqual([]);
    expect(bumped[0].manifest.dependencies.react).toBe("^19.0.0");
    expect(manifests[0].manifest.version).toBe("0.1.0");
    expect(() => bumpManifests(manifests, "v0.2.0")).toThrow(/semantic version/);
  });

  it("runs current, check and bump against a folder, and refuses a bad version", () => {
    writeWorkspace(dir);
    expect(runVersion(["current"], dir)).toEqual({ code: 0, out: ["0.1.0"], err: [] });
    expect(runVersion(["check", "0.1.0"], dir).code).toBe(0);
    expect(runVersion(["check", "0.2.0"], dir).code).toBe(1);
    const bad = runVersion(["check", "0.2.0\n::error::x"], dir);
    expect(bad.code).toBe(1);
    expect(bad.err.join("\n")).not.toContain("::error::x");
    expect(runVersion(["bump", "0.2.0"], dir).code).toBe(0);
    const app = JSON.parse(readFileSync(join(dir, "packages", "app", "package.json"), "utf8"));
    expect(app.version).toBe("0.2.0");
    expect(app.dependencies["@synthetic/lib"]).toBe("0.2.0");
    expect(readFileSync(join(dir, "packages", "app", "package.json"), "utf8").endsWith("}\n")).toBe(
      true,
    );
    expect(runVersion(["current"], dir).out).toEqual(["0.2.0"]);
    expect(runVersion([], dir).code).toBe(2);
  });

  it("the repository's packages share one version", () => {
    expect(sharedVersion(readManifests(REPO_ROOT))).not.toBeNull();
  });
});

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added

- A synthetic widget.

## [0.1.0] - 2026-01-02

### Fixed

- A synthetic bug.

[Unreleased]: https://example.com/repo/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/repo/releases/tag/v0.1.0
`;

describe("compareVersions", () => {
  it("orders versions as Semantic Versioning 2.0.0 does", () => {
    const sorted = [
      "1.0.0",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-beta.11",
      "1.0.0-beta.2",
      "0.9.0",
      "1.0.0-rc.1",
    ].sort(compareVersions);
    expect(sorted).toEqual([
      "0.9.0",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ]);
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0);
  });
});

describe("changelog", () => {
  it("parses sections, link references and the head", () => {
    const parsed = parseChangelog(CHANGELOG);
    expect(parsed.sections.map((section) => [section.name, section.date])).toEqual([
      ["Unreleased", null],
      ["0.1.0", "2026-01-02"],
    ]);
    expect(parsed.links.map((link) => link.name)).toEqual(["Unreleased", "0.1.0"]);
    expect(parsed.head[0]).toBe("# Changelog");
  });

  it("accepts a valid changelog and the repository's own", () => {
    expect(validateChangelog(CHANGELOG)).toEqual([]);
    expect(validateChangelog(readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8"))).toEqual([]);
  });

  it("reports each format problem", () => {
    const broken = [
      "# Notes",
      "## [0.1.0] - 2026-02-30",
      "### Improved",
      "## [Unreleased]",
      "## [0.2.0] - 2026-03-01",
      "## Version 3",
      "## [0.2.0] - 2026-03-01",
    ].join("\n");
    expect(validateChangelog(broken)).toEqual([
      'the first line must be "# Changelog"',
      'line 6: a "## " heading must be "## [Unreleased]" or "## [x.y.z] - YYYY-MM-DD"',
      'the first section must be "## [Unreleased]"',
      "line 2: [0.1.0] needs a date as YYYY-MM-DD",
      `line 3: "### Improved" is not one of ${CHANGE_TYPES.join(", ")}`,
      "line 4: [Unreleased] must come first",
      "line 5: [0.2.0] must come below newer versions",
      "line 7: section [0.2.0] is repeated",
      "line 7: [0.2.0] must come below newer versions",
    ]);
  });

  it("returns the notes of one section and refuses a missing or empty one", () => {
    expect(sectionNotes(CHANGELOG, "0.1.0")).toBe("### Fixed\n\n- A synthetic bug.");
    expect(() => sectionNotes(CHANGELOG, "9.9.9")).toThrow(/no section/);
    expect(() => sectionNotes("# Changelog\n\n## [Unreleased]\n\n", "Unreleased")).toThrow(/empty/);
  });

  it("moves Unreleased into a new version section and updates the links", () => {
    const next = releaseChangelog(CHANGELOG, "0.2.0", "2026-02-03", "https://example.com/repo");
    expect(validateChangelog(next)).toEqual([]);
    expect(sectionNotes(next, "0.2.0")).toBe("### Added\n\n- A synthetic widget.");
    expect(() => sectionNotes(next, "Unreleased")).toThrow(/empty/);
    expect(next).toContain("[Unreleased]: https://example.com/repo/compare/v0.2.0...HEAD");
    expect(next).toContain("[0.2.0]: https://example.com/repo/compare/v0.1.0...v0.2.0");
    expect(next).toContain("[0.1.0]: https://example.com/repo/releases/tag/v0.1.0");
    expect(next).toContain("Intro text.");
  });

  it("links the first release to its tag", () => {
    const first = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Everything.\n";
    const next = releaseChangelog(first, "0.1.0", "2026-02-03", "https://example.com/repo");
    expect(next).toContain("[0.1.0]: https://example.com/repo/releases/tag/v0.1.0");
  });

  it("refuses to release nothing, an old version, a repeated version or a bad date", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-02\n\n- x\n";
    expect(() => releaseChangelog(empty, "0.2.0", "2026-02-03")).toThrow(/nothing to release/);
    expect(() => releaseChangelog(CHANGELOG, "0.0.9", "2026-02-03")).toThrow(/newer/);
    expect(() => releaseChangelog(CHANGELOG, "0.1.0", "2026-02-03")).toThrow(/already/);
    expect(() => releaseChangelog(CHANGELOG, "0.2.0", "03/02/2026")).toThrow(/YYYY-MM-DD/);
  });

  it("runs check, notes and release against a file", () => {
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, CHANGELOG);
    expect(runChangelog(["check"], file).code).toBe(0);
    expect(runChangelog(["check", "--version", "0.1.0"], file).code).toBe(0);
    expect(runChangelog(["check", "--version", "0.3.0"], file).code).toBe(1);
    expect(runChangelog(["notes", "0.1.0"], file).out).toEqual(["### Fixed\n\n- A synthetic bug."]);
    expect(runChangelog(["notes", "bad version"], file).code).toBe(1);
    expect(runChangelog(["release", "0.2.0", "--date", "2026-02-03"], file).code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("## [0.2.0] - 2026-02-03");
    expect(runChangelog(["unknown"], file).code).toBe(2);
  });
});
