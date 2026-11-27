// Tests for scripts/release/preflight.mjs, pack-release.mjs and the release workflow file.
// Synthetic inputs only. Output folders are temporary and removed by each test. The packing
// tests run after `npm run build`; the .vsix test also needs `npm ci` in scripts/release/tools.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NPM_PACKAGES, REPO_ROOT, TOOLS_DIR, sha256File } from "./lib.mjs";
import {
  checksumsText,
  markdownSummary,
  outputFolderProblem,
  packAndCheckVsix,
  packRelease,
  parseArgs,
  vsixIdentity,
} from "./pack-release.mjs";
import { annotations, inputFromEnvironment, preflight } from "./preflight.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbitrace-pack-release-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-02-03

### Added

- A synthetic widget.
`;

/** Synthetic manifests in the shape readManifests returns. */
function manifests(version, { publisher = "synthetic-publisher", cliPrivate = false } = {}) {
  return [
    { dir: "cli", manifest: { name: "synthetic-cli", version, private: cliPrivate } },
    { dir: "core", manifest: { name: "@synthetic/core", version } },
    { dir: "vscode", manifest: { name: "synthetic-vscode", version, publisher } },
  ];
}

function input(overrides = {}) {
  return {
    version: "0.2.0",
    dryRun: true,
    refType: "branch",
    refName: "dev",
    manifests: manifests("0.2.0"),
    changelog: CHANGELOG,
    ...overrides,
  };
}

describe("preflight", () => {
  it("lets a dry run from a branch through, with notices", () => {
    const result = preflight(input());
    expect(result.errors).toEqual([]);
    expect(result.notices.join("\n")).toMatch(/nothing is published/);
    expect(result.notices.join("\n")).toMatch(/for testing only/);
  });

  it("stops a bad version before using it anywhere", () => {
    const result = preflight(input({ version: "0.2.0\n::error::planted" }));
    expect(result.errors).toHaveLength(1);
    expect(annotations(result).join("\n")).not.toContain("planted");
  });

  it("stops a run whose packages are not at the version", () => {
    const result = preflight(input({ version: "0.3.0" }));
    expect(result.errors.join("\n")).toMatch(/expected 0\.3\.0/);
  });

  it("stops a run on a tag that does not match the version, even a dry run", () => {
    expect(preflight(input({ refType: "tag", refName: "v0.1.0" })).errors).toHaveLength(1);
    expect(preflight(input({ refType: "tag", refName: "v0.2.0" })).errors).toEqual([]);
  });

  it("allows a real release only from the matching tag, with a changelog section and a publisher", () => {
    const real = { dryRun: false, refType: "tag", refName: "v0.2.0" };
    expect(preflight(input(real)).errors).toEqual([]);
    expect(
      preflight(input({ ...real, refType: "branch", refName: "main" })).errors.join("\n"),
    ).toMatch(/must run from the v0\.2\.0 tag/);
    const noSection = preflight(input({ ...real, changelog: "# Changelog\n\n## [Unreleased]\n" }));
    expect(noSection.errors.join("\n")).toMatch(/needs a non-empty 0\.2\.0 section/);
    const noPublisher = preflight(
      input({ ...real, manifests: manifests("0.2.0", { publisher: "" }) }),
    );
    expect(noPublisher.errors.join("\n")).toMatch(/publisher/);
  });

  it("only warns about a missing publisher in a dry run", () => {
    const result = preflight(input({ manifests: manifests("0.2.0", { publisher: "" }) }));
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/undefined_publisher/);
  });

  it("refuses to release the 0.0.0 placeholder and warns about a private CLI and a pre-release", () => {
    const placeholder = preflight(
      input({
        version: "0.0.0",
        dryRun: false,
        refType: "tag",
        refName: "v0.0.0",
        manifests: manifests("0.0.0"),
      }),
    );
    expect(placeholder.errors.join("\n")).toMatch(/placeholder/);
    const rc = preflight(
      input({
        version: "1.0.0-rc.1",
        dryRun: false,
        refType: "tag",
        refName: "v1.0.0-rc.1",
        manifests: manifests("1.0.0-rc.1", { cliPrivate: true }),
        changelog: "# Changelog\n\n## [Unreleased]\n\n## [1.0.0-rc.1] - 2026-02-03\n\n- x\n",
      }),
    );
    expect(rc.errors).toEqual([]);
    expect(rc.warnings.join("\n")).toMatch(/private/);
    expect(rc.warnings.join("\n")).toMatch(/pre-release/);
  });

  it("treats anything but DRY_RUN=false as a dry run", () => {
    const base = { VERSION: "0.0.0", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "dev" };
    expect(inputFromEnvironment({ ...base, DRY_RUN: "true" }).dryRun).toBe(true);
    expect(inputFromEnvironment({ ...base, DRY_RUN: "False" }).dryRun).toBe(true);
    expect(inputFromEnvironment({ ...base }).dryRun).toBe(true);
    expect(inputFromEnvironment({ ...base, DRY_RUN: "false" }).dryRun).toBe(false);
  });

  it("passes a dry run of the repository as it is", () => {
    const env = { VERSION: "", DRY_RUN: "true", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "dev" };
    const repo = inputFromEnvironment(env);
    expect(preflight({ ...repo, version: repo.manifests[0].manifest.version }).errors).toEqual([]);
  });

  it("writes one annotation line per message, with newlines escaped", () => {
    expect(annotations({ errors: ["a\nb"], warnings: ["w"], notices: ["n"] })).toEqual([
      "::notice title=Release preflight::n",
      "::warning title=Release preflight::w",
      "::error title=Release preflight::a%0Ab",
    ]);
  });
});

describe("pack-release helpers", () => {
  it("parses the arguments", () => {
    expect(
      parseArgs(["--out", "/x", "--version", "0.2.0", "--skip-vsix", "--require-publisher"]),
    ).toEqual({
      out: "/x",
      version: "0.2.0",
      skipVsix: true,
      requirePublisher: true,
      summary: null,
    });
    expect(() => parseArgs([])).toThrow(/--out is required/);
    expect(() => parseArgs(["--out"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--out", "/x", "--version", "v1"])).toThrow(/semantic version/);
    expect(() => parseArgs(["--out", "/x", "--publish"])).toThrow(/unknown argument/);
  });

  it("refuses an output folder inside the repository or one that is not empty", () => {
    expect(outputFolderProblem(join(REPO_ROOT, "out"))).toMatch(/outside the repository/);
    expect(outputFolderProblem(join(dir, "new"))).toBeNull();
    writeFileSync(join(dir, "old.tgz"), "x");
    expect(outputFolderProblem(dir)).toMatch(/empty/);
  });

  it("reads the identity of a .vsix manifest", () => {
    const xml =
      '<PackageManifest><Metadata><Identity Language="en-US" Id="synthetic-ext" Version="0.2.0" Publisher="synthetic-pub" /></Metadata></PackageManifest>';
    expect(vsixIdentity(xml)).toEqual({
      publisher: "synthetic-pub",
      id: "synthetic-ext",
      version: "0.2.0",
    });
    expect(vsixIdentity("<x/>")).toEqual({ publisher: null, id: null, version: null });
  });

  it("writes SHA256SUMS lines that sha256sum -c reads", () => {
    expect(
      checksumsText([
        { file: "a.tgz", sha256: "ab" },
        { file: "b.vsix", sha256: "cd" },
      ]),
    ).toBe("ab  a.tgz\ncd  b.vsix\n");
  });

  it("summarises the artefacts in Markdown", () => {
    const text = markdownSummary({
      version: "0.2.0",
      commit: "abc123",
      artefacts: [
        {
          name: "a",
          file: "a.tgz",
          size: 2048,
          sha256: "ab",
          files: [1, 2],
          errors: [],
          warnings: ["w"],
        },
        {
          name: "b",
          file: "b.tgz",
          size: 10,
          sha256: "cd",
          files: [1],
          errors: ["e"],
          warnings: [],
        },
      ],
    });
    expect(text).toContain("## Release artefacts 0.2.0");
    expect(text).toContain("Nothing was published.");
    expect(text).toContain("| `a.tgz` | 2.0 KiB | 2 | `ab` | ok, with warnings |");
    expect(text).toContain("| `b.tgz` | 10 B | 1 | `cd` | 1 error(s) |");
    expect(text).toContain("- b: error: e");
  });
});

const built = NPM_PACKAGES.every((spec) =>
  existsSync(join(REPO_ROOT, "packages", spec.dir, "dist", "index.js")),
);
const vsceInstalled = existsSync(join(TOOLS_DIR, "node_modules", ".bin", "vsce"));
const extensionBuilt = existsSync(join(REPO_ROOT, "packages", "vscode", "dist", "extension.js"));

describe.skipIf(!built)("packRelease (after npm run build)", () => {
  it(
    "writes the three tarballs, SHA256SUMS and the manifest, all checked",
    { timeout: 120_000 },
    () => {
      const out = join(dir, "artefacts");
      const result = packRelease(parseArgs(["--out", out, "--skip-vsix"]));
      expect(result.artefacts.map((a) => a.name)).toEqual(NPM_PACKAGES.map((spec) => spec.name));
      expect(result.artefacts.flatMap((a) => a.errors.map((e) => `${a.name}: ${e}`))).toEqual([]);
      for (const artefact of result.artefacts) {
        expect(sha256File(join(out, artefact.file))).toBe(artefact.sha256);
      }
      const sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
      expect(sums.trim().split("\n")).toHaveLength(3);
      const manifest = JSON.parse(readFileSync(join(out, "release-manifest.json"), "utf8"));
      expect(manifest.version).toBe(result.version);
      expect(JSON.stringify(manifest)).not.toContain(REPO_ROOT);
    },
  );

  it("refuses a version the packages do not have", () => {
    expect(() => packRelease(parseArgs(["--out", join(dir, "x"), "--version", "99.0.0"]))).toThrow(
      /do not share one version/,
    );
  });
});

describe.skipIf(!vsceInstalled || !extensionBuilt)(
  "packAndCheckVsix (needs scripts/release/tools)",
  () => {
    it("packages the extension and checks the .vsix", { timeout: 120_000 }, () => {
      const out = join(dir, "out");
      mkdirSync(out);
      const version = JSON.parse(
        readFileSync(join(REPO_ROOT, "packages", "vscode", "package.json"), "utf8"),
      ).version;
      const report = packAndCheckVsix({
        root: REPO_ROOT,
        out,
        workDir: dir,
        version,
        requirePublisher: false,
      });
      expect(report.errors).toEqual([]);
      expect(report.files.map((file) => file.path)).toContain("extension/dist/extension.js");
      expect(existsSync(join(out, report.file))).toBe(true);
    });
  },
);

describe("the release workflow", () => {
  const text = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
  const lines = text.split("\n");
  const code = lines.filter((line) => !line.trim().startsWith("#"));

  it("is started by hand only", () => {
    const start = code.findIndex((line) => line === "on:");
    const end = code.findIndex((line, index) => index > start && /^\S/.test(line));
    const triggers = code
      .slice(start + 1, end)
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim());
    expect(triggers).toEqual(["workflow_dispatch:"]);
    expect(code.join("\n")).not.toMatch(/pull_request_target/);
  });

  it("defaults to a dry run", () => {
    const at = code.findIndex((line) => line.trim() === "dry_run:");
    const block = code.slice(at, at + 6).join("\n");
    expect(block).toMatch(/type: boolean/);
    expect(block).toMatch(/default: true/);
  });

  it("keeps every publish job disabled and behind dry_run", () => {
    const jobs = code.filter((line) => /^ {2}publish-[\w-]+:$/.test(line));
    expect(jobs.length).toBe(3);
    const bodies = jobs.map((job) => {
      const at = code.indexOf(job);
      const next = code.findIndex((line, index) => index > at && /^ {2}\S/.test(line));
      return code.slice(at, next === -1 ? undefined : next).join("\n");
    });
    for (const body of bodies) {
      expect(body).toMatch(/\n {4}if: \$\{\{ false && !inputs\.dry_run \}\}\n/);
      expect(body).toMatch(/\n {4}environment: \S+\n/);
    }
  });

  it("grants no permission at the top level and contents: write to the draft release only", () => {
    expect(code).toContain("permissions: {}");
    const writes = code.filter((line) => /contents: write/.test(line));
    expect(writes).toHaveLength(1);
    const draft = code.indexOf("  draft-release:");
    const write = code.findIndex((line) => /contents: write/.test(line));
    const nextJob = code.findIndex((line, index) => index > draft && /^ {2}\S/.test(line));
    expect(write > draft && write < nextJob).toBe(true);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = code.filter((line) => /\buses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/);
  });

  it("passes inputs and secrets to shell steps through env only", () => {
    const shellLines = [];
    let inRun = false;
    let runIndent = 0;
    for (const line of code) {
      const indent = line.length - line.trimStart().length;
      if (inRun && line.trim() !== "" && indent <= runIndent) inRun = false;
      const run = /^(\s*)(- )?run: (.*)$/.exec(line);
      if (run) {
        shellLines.push(run[3]);
        inRun = run[3].trim() === "|";
        runIndent = run[1].length + (run[2] ? 2 : 0);
      } else if (inRun) {
        shellLines.push(line);
      }
    }
    expect(shellLines.length).toBeGreaterThan(10);
    expect(shellLines.filter((line) => line.includes("${{"))).toEqual([]);
    const secretLines = code.filter((line) => line.includes("secrets."));
    expect(secretLines.length).toBeGreaterThan(0);
    expect(
      secretLines.filter((line) => !/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/.test(line)),
    ).toEqual([]);
  });
});
