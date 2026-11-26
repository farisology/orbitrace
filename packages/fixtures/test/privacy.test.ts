/**
 * Every fixture must pass the repository's privacy check (npm run privacy). The check lives
 * in scripts/privacy-check.mjs at the repository root. It is loaded from there rather than
 * copied, so the fixtures are held to the rules the repository actually enforces.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SEED,
  FIXTURES_DIR,
  SCENARIO_NAMES,
  SYNTHETIC_MARKER,
  goldenReplayFile,
  goldenReplayPath,
  renderFixtureTree,
  renderGoldenReplays,
  type GeneratedFile,
} from "../src/index.js";

interface PrivacyRule {
  id: string;
  pattern: RegExp;
  allow?: (match: string) => boolean;
}

interface PrivacyCheck {
  RULES: PrivacyRule[];
  loadDenylist: (root: string) => PrivacyRule[];
  listFiles: (root: string) => string[];
  scanText: (text: string, rules: PrivacyRule[]) => { line: number; rule: string }[];
  scanFiles: (
    root: string,
    files: string[],
    rules: PrivacyRule[],
  ) => { scanned: number; findings: { file: string; line: number; rule: string }[] };
}

const REPO_ROOT = dirname(FIXTURES_DIR);
const SEEDS = [DEFAULT_SEED, ...Array.from({ length: 24 }, (_, index) => `privacy-${index}`)];

let privacy: PrivacyCheck;
let rules: PrivacyRule[];

beforeAll(async () => {
  // A computed specifier: the script is plain JavaScript outside this package.
  const scriptUrl = pathToFileURL(join(REPO_ROOT, "scripts", "privacy-check.mjs")).href;
  privacy = (await import(scriptUrl)) as PrivacyCheck;
  // The local denylist is git-ignored and may be absent. When present, it applies too.
  rules = [...privacy.RULES, ...privacy.loadDenylist(REPO_ROOT)];
});

function findings(files: readonly GeneratedFile[]): string[] {
  return files.flatMap((file) =>
    privacy.scanText(file.content, rules).map((hit) => `${file.path}:${hit.line}: ${hit.rule}`),
  );
}

describe("privacy of the fixtures", () => {
  it("the check that is used does flag the things it is meant to flag", () => {
    // Built from pieces, so this file does not hold a string the check would flag.
    const homePath = ["", "Users", "someone", "project"].join("/");
    const linuxPath = ["", "home", "someone"].join("/");
    const address = ["someone", "mail.invalid"].join("@");
    const planted: GeneratedFile[] = [
      { path: "a.jsonl", content: `{"cwd":"${homePath}"}\n{"ok":true}\n{"cwd":"${linuxPath}"}\n` },
      { path: "b.jsonl", content: `{"text":"write to ${address}"}\n` },
    ];
    expect(privacy.RULES.length).toBeGreaterThanOrEqual(9);
    expect(findings(planted)).toEqual([
      "a.jsonl:1: home-path-macos",
      "a.jsonl:3: home-path-linux",
      "b.jsonl:1: email",
    ]);
  });

  it.each(SEEDS)("generated with seed '%s', every file passes the privacy check", (seed) => {
    const files = renderFixtureTree({ seed });
    expect(files.length).toBeGreaterThan(40);
    expect(findings(files)).toEqual([]);
  });

  it("the committed fixture files pass the privacy check, and none is hidden from it", () => {
    // listFiles is what `npm run privacy` scans: tracked files and untracked files that are
    // not ignored. A fixture missing from it would be ignored by git, and never committed.
    const listed = privacy.listFiles(REPO_ROOT).filter((file) => file.startsWith("fixtures/"));
    const generated = renderFixtureTree().map((file) => `fixtures/${file.path}`);
    expect(generated.filter((file) => !listed.includes(file))).toEqual([]);
    const goldens = SCENARIO_NAMES.map((name) => `fixtures/${goldenReplayFile(name)}`);
    expect(goldens.filter((file) => !listed.includes(file))).toEqual([]);
    const result = privacy.scanFiles(REPO_ROOT, listed, rules);
    expect(result.findings).toEqual([]);
    expect(result.scanned).toBe(listed.length);
  });

  it("the golden replays pass the privacy check, committed and regenerated", async () => {
    const committed: GeneratedFile[] = SCENARIO_NAMES.map((name) => ({
      path: goldenReplayFile(name),
      content: readFileSync(goldenReplayPath(name), "utf8"),
    }));
    expect(committed.every((file) => file.content.length > 0)).toBe(true);
    expect(findings(committed)).toEqual([]);
    expect(findings(await renderGoldenReplays())).toEqual([]);
    // A replay has no free text at all: no at-sign, no slash, no space inside a value.
    for (const file of committed) {
      const strings = file.content.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
      expect(strings.filter((value) => /[@/\\\s]/.test(value))).toEqual([]);
    }
  });

  it("holds no home folder, no address and no real-looking id in any generated file", () => {
    const problems: string[] = [];
    for (const seed of SEEDS.slice(0, 6)) {
      for (const file of renderFixtureTree({ seed })) {
        const at = `${seed}: ${file.path}`;
        if (/\/Users\/|\/home\/|[A-Za-z]:\\|~\//.test(file.content)) problems.push(`${at} path`);
        // The one at-sign in the set is the package name the manifest gives as generator.
        if (file.content.replace('"@orbitrace/fixtures"', "").includes("@")) {
          problems.push(`${at} at-sign`);
        }
        if (/\.claude\b/.test(file.content)) problems.push(`${at} config folder name`);
        // Every id is visibly invented: session ids and uuids start with a group of zeros.
        const uuids = file.content.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        );
        if ((uuids ?? []).some((id) => !id.startsWith("00000000-"))) problems.push(`${at} uuid`);
        const apiIds = file.content.match(/\b(?:msg|req|toolu)_[0-9A-Za-z]+/g);
        if ((apiIds ?? []).some((id) => !/^(msg|req|toolu)_01SYNTH/.test(id))) {
          problems.push(`${at} api id`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("says in the fixtures folder that the data is invented", () => {
    const readme = readFileSync(join(FIXTURES_DIR, "README.md"), "utf8");
    expect(readme).toMatch(/synthetic/i);
    expect(readme).toContain("npm run generate -w @orbitrace/fixtures");
    expect(SYNTHETIC_MARKER).toBe("Synthetic");
  });
});
