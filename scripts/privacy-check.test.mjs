// Tests for scripts/privacy-check.mjs.
// Planted strings are assembled at run time from fragments, so this file never contains a
// literal match. Every fixture is written into a temporary folder that the test removes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkRange,
  checkRepository,
  COMMIT_MESSAGE_LABEL,
  headerPath,
  isAllowedEmail,
  listRangeCommits,
  parseArgs,
  scanPatch,
  scanText,
  RULES,
} from "./privacy-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "privacy-check.mjs");

const planted = {
  "home-path-macos": "/" + "Users/" + "synthetic-person/notes.txt",
  "home-path-linux": "/" + "home/" + "synthetic-person/notes.txt",
  "home-path-windows": "C:" + "\\Users\\" + "synthetic-person\\notes.txt",
  email: "synthetic.person" + "@" + "mail-test.invalid",
  "github-token": "gh" + "p_" + "AbCdEf1234567890GhIjKl",
  "anthropic-key": "sk" + "-ant-" + "SYNTHETIC123456789",
  "digitalocean-token": "dop" + "_v1_" + "SYNTHETIC1234567890",
  "aws-access-key-id": "AKIA" + "ABCDEFGH12345678",
  "private-key-block": "-----BEGIN " + "RSA PRIVATE KEY-----",
};

// Other spellings that the same rules must catch.
const variants = [
  ["home-path-macos", '"cwd": "/' + "Users/" + 'synthetic-person"'],
  ["home-path-linux", '"cwd": "/' + "home/" + 'synthetic-person"'],
  // A JSON-escaped Windows path: two backslashes per separator in the file.
  ["home-path-windows", '"C:' + "\\\\Users\\\\" + 'synthetic-person"'],
  ["home-path-windows", "D:" + "/Users/" + "synthetic-person/notes.txt"],
  ["github-token", "gh" + "o_" + "AbCdEf1234567890"],
  ["github-token", "gh" + "s_" + "AbCdEf1234567890"],
  ["github-token", "gh" + "u_" + "AbCdEf1234567890"],
  ["private-key-block", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"],
];

// Text that must pass: placeholders, package scopes and version specifiers.
const notFlagged = [
  "Transcripts live under ~/.claude/projects/<project>/ on macOS and Linux.",
  "/" + "Users/<name>/.claude and /" + "home/<name>/.claude are placeholders.",
  "Scope: @orbitrace/core and dist/index.js",
  "react" + "@" + "19.3.1",
];

const allowed = [
  "12345+synthetic-user@users.noreply.github.com",
  "docs@example.com",
  "docs@mail.example.com",
];

let tempRoot;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "privacy-check-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeFixture(relativePath, lines) {
  const fullPath = join(tempRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, lines.join("\n") + "\n", "utf8");
}

function gitInit() {
  const result = spawnSync("git", ["init", "--quiet"], { cwd: tempRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr}`);
  // The real repository ignores the denylist file, so the fixture must too.
  writeFixture(".gitignore", [".privacy-denylist.local"]);
}

function runScript(...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: tempRoot, encoding: "utf8" });
}

describe("scanText", () => {
  it.each(Object.entries(planted))("flags a planted %s with its line number", (ruleId, value) => {
    const text = ["clean line", "another clean line", value].join("\n");
    const findings = scanText(text, RULES);
    expect(findings).toContainEqual({ line: 3, rule: ruleId });
  });

  it.each(allowed)("does not flag the allowed address %s", (address) => {
    expect(isAllowedEmail(address)).toBe(true);
    expect(scanText(`contact ${address} for details`, RULES)).toEqual([]);
  });

  it.each(variants)("flags the %s variant %#", (ruleId, value) => {
    expect(scanText(value, RULES)).toContainEqual({ line: 1, rule: ruleId });
  });

  it.each(notFlagged)("does not flag: %s", (text) => {
    expect(scanText(text, RULES)).toEqual([]);
  });
});

describe("checkRepository", () => {
  it("scans untracked, non-ignored files and reports file and line", () => {
    gitInit();
    writeFixture("packages/sample/src/leak.txt", ["ok", planted.email]);
    const result = checkRepository(tempRoot);
    expect(result.findings).toEqual([
      { file: "packages/sample/src/leak.txt", line: 2, rule: "email" },
    ]);
    // .gitignore and the leaking file.
    expect(result.scanned).toBe(2);
  });

  it("skips files matched by .gitignore", () => {
    gitInit();
    writeFixture(".gitignore", ["ignored.txt", ".privacy-denylist.local"]);
    writeFixture("ignored.txt", [planted["github-token"]]);
    writeFixture("visible.txt", ["clean"]);
    const result = checkRepository(tempRoot);
    expect(result.findings).toEqual([]);
    expect(result.scanned).toBe(2);
  });

  it("applies patterns from .privacy-denylist.local and ignores comments", () => {
    gitInit();
    writeFixture(".privacy-denylist.local", ["# comment line", "", "synthetic-codename"]);
    writeFixture("notes.txt", ["nothing here", "The SYNTHETIC-CODENAME appears here"]);
    const result = checkRepository(tempRoot);
    expect(result.findings).toEqual([{ file: "notes.txt", line: 2, rule: "denylist" }]);
  });

  it("rejects an invalid denylist pattern without echoing it", () => {
    gitInit();
    writeFixture(".privacy-denylist.local", ["unclosed ( group"]);
    writeFixture("notes.txt", ["clean"]);
    expect(() => checkRepository(tempRoot)).toThrow(
      `${".privacy-denylist.local"}:1: not a valid regular expression`,
    );
  });
});

describe("npm run privacy entry point", () => {
  it("exits 1 and prints file:line without the matched text", () => {
    gitInit();
    writeFixture("planted.txt", ["line one", "line two", planted["anthropic-key"]]);
    const result = runScript();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("planted.txt:3: anthropic-key");
    expect(result.stderr).not.toContain(planted["anthropic-key"]);
  });

  it("exits 0 when the repository is clean", () => {
    gitInit();
    writeFixture("clean.txt", ["nothing to see"]);
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 findings");
  });
});

// ---------------------------------------------------------------------------------------
// History mode (--range). Commits are made in the temporary repository with a synthetic
// identity, signing and hooks off, so the developer's own git configuration does not leak in
// or change the result.

const GIT_ISOLATION = [
  "-c",
  "user.name=Synthetic Tester",
  "-c",
  "user.email=tester@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

function git(...args) {
  const result = spawnSync("git", [...GIT_ISOLATION, ...args], {
    cwd: tempRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Stage everything and commit; returns the new commit sha. */
function commitAll(message) {
  git("add", "--all");
  git("commit", "--quiet", "--no-verify", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
}

/** A repository whose first commit is the clean base. Returns the base sha. */
function gitInitWithBase() {
  gitInit();
  git("checkout", "--quiet", "-b", "base-branch");
  writeFixture("README.txt", ["synthetic project", "second line"]);
  return commitAll("chore: synthetic base");
}

describe("parseArgs", () => {
  it("defaults to the tree scan", () => {
    expect(parseArgs([])).toEqual({ mode: "tree" });
  });

  it.each([[["--range", "abc123..def456"]], [["--range=abc123..def456"]]])(
    "reads a range from %j",
    (args) => {
      expect(parseArgs(args)).toEqual({ mode: "range", range: "abc123..def456" });
    },
  );

  it.each([
    [["--range"]],
    [["--unknown"]],
    [["--range", "a..b", "extra"]],
    [["--range", "-a..b"]],
    [["--range=--output=x..y"]],
    [["--range", "single-revision"]],
    [["--range", "a.. b"]],
    [["--range="]],
  ])("rejects %j", (args) => {
    expect(() => parseArgs(args)).toThrow(/usage:/);
  });
});

describe("headerPath", () => {
  it.each([
    ["b/packages/core/src/a.ts", "packages/core/src/a.ts"],
    ["b/name with space.txt\t", "name with space.txt"],
    ['"b/quoted\\tname.txt"', "quoted\\tname.txt"],
    ["/dev/null", null],
  ])("maps %j to %j", (header, expected) => {
    expect(headerPath(header)).toBe(expected);
  });
});

describe("scanPatch", () => {
  const patch = [
    "diff --git a/notes.txt b/notes.txt",
    "index 1111111..2222222 100644",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -2,0 +3,2 @@ heading",
    "+clean added line",
    "+" + planted.email,
    "@@ -10 +12 @@",
    "-" + planted["github-token"],
    "+" + planted["aws-access-key-id"],
    "\\ No newline at end of file",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-" + planted["anthropic-key"],
    "diff --git a/odd.txt b/odd.txt",
    "--- a/odd.txt",
    "+++ b/odd.txt",
    "@@ -0,0 +1,2 @@",
    // An added line whose content looks like a file header is still content.
    "+++ " + planted["digitalocean-token"],
    "+" + planted["home-path-linux"],
  ].join("\n");

  it("flags added lines with their new-file line numbers and ignores removed lines", () => {
    expect(scanPatch(patch, RULES)).toEqual([
      { file: "notes.txt", line: 4, rule: "email" },
      { file: "notes.txt", line: 12, rule: "aws-access-key-id" },
      { file: "odd.txt", line: 1, rule: "digitalocean-token" },
      { file: "odd.txt", line: 2, rule: "home-path-linux" },
    ]);
  });

  it("returns nothing for a clean patch", () => {
    const clean = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(scanPatch(clean, RULES)).toEqual([]);
  });
});

describe("listRangeCommits", () => {
  it("lists the commits after the base, oldest first, and marks merges", () => {
    const base = gitInitWithBase();
    git("checkout", "--quiet", "-b", "side");
    writeFixture("side.txt", ["side work"]);
    const side = commitAll("feat: side work");
    git("checkout", "--quiet", "base-branch");
    writeFixture("main.txt", ["main work"]);
    const mainWork = commitAll("feat: main work");
    git("merge", "--quiet", "--no-ff", "--no-edit", "side");
    const merge = git("rev-parse", "HEAD");

    const commits = listRangeCommits(tempRoot, `${base}..${merge}`);
    expect(commits.map((c) => c.sha).sort()).toEqual([side, mainWork, merge].sort());
    expect(commits.at(-1)).toEqual({ sha: merge, merge: true });
    expect(commits.filter((c) => c.merge)).toHaveLength(1);
  });
});

describe("checkRange", () => {
  it("passes a clean range", () => {
    const base = gitInitWithBase();
    writeFixture("src/feature.txt", ["clean feature", "docs@example.com"]);
    const head = commitAll("feat: clean feature");
    expect(checkRange(tempRoot, `${base}..${head}`)).toEqual({ commits: 1, findings: [] });
  });

  it("flags a value added in one commit and removed in a later one", () => {
    const base = gitInitWithBase();
    writeFixture("src/config.txt", ["setting = 1", "token = " + planted["github-token"]]);
    const leak = commitAll("feat: add config");
    writeFixture("src/config.txt", ["setting = 1"]);
    const head = commitAll("fix: remove the value");

    // The tree is clean now, so only the history scan can see the leak.
    expect(checkRepository(tempRoot).findings).toEqual([]);
    const result = checkRange(tempRoot, `${base}..${head}`);
    expect(result.commits).toBe(2);
    expect(result.findings).toEqual([
      { commit: leak.slice(0, 12), file: "src/config.txt", line: 2, rule: "github-token" },
    ]);
  });

  it("flags a commit message and applies the local denylist", () => {
    const base = gitInitWithBase();
    writeFixture(".privacy-denylist.local", ["synthetic-codename"]);
    writeFixture("notes.txt", ["about Synthetic-Codename"]);
    const head = commitAll("docs: notes\n\nWritten in " + planted["home-path-macos"]);
    const result = checkRange(tempRoot, `${base}..${head}`);
    expect(result.findings).toEqual([
      { commit: head.slice(0, 12), file: COMMIT_MESSAGE_LABEL, line: 3, rule: "home-path-macos" },
      { commit: head.slice(0, 12), file: "notes.txt", line: 1, rule: "denylist" },
    ]);
  });

  it("does not scan the diff of a merge commit, only its message", () => {
    const base = gitInitWithBase();
    // The value lands on the base branch after the range starts, then is merged in.
    git("checkout", "--quiet", "-b", "feature");
    writeFixture("feature.txt", ["feature"]);
    commitAll("feat: feature");
    git("checkout", "--quiet", "base-branch");
    writeFixture("upstream.txt", [planted["aws-access-key-id"]]);
    const upstream = commitAll("chore: upstream change");
    git("checkout", "--quiet", "feature");
    git("merge", "--quiet", "--no-ff", "--no-edit", "base-branch");
    const head = git("rev-parse", "HEAD");

    // Range from the new base tip: the upstream commit is excluded, the merge adds nothing.
    expect(checkRange(tempRoot, `${upstream}..${head}`).findings).toEqual([]);
    // Range from the old base: the upstream commit itself is in range and is flagged.
    expect(checkRange(tempRoot, `${base}..${head}`).findings).toEqual([
      { commit: upstream.slice(0, 12), file: "upstream.txt", line: 1, rule: "aws-access-key-id" },
    ]);
  });

  it("throws when a revision does not exist", () => {
    const base = gitInitWithBase();
    expect(() => checkRange(tempRoot, `${base}..no-such-branch`)).toThrow();
  });
});

describe("npm run privacy -- --range entry point", () => {
  it("exits 1 and prints sha:file:line without the matched text", () => {
    const base = gitInitWithBase();
    writeFixture("leak.txt", ["ok", planted["anthropic-key"]]);
    const leak = commitAll("feat: leak");
    writeFixture("leak.txt", ["ok"]);
    const head = commitAll("fix: tidy");
    const result = runScript("--range", `${base}..${head}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${leak.slice(0, 12)}:leak.txt:2: anthropic-key`);
    expect(result.stderr).toContain("privacy history check failed: 1 finding(s)");
    expect(result.stderr).not.toContain(planted["anthropic-key"]);
  });

  it("exits 0 for a clean range", () => {
    const base = gitInitWithBase();
    writeFixture("clean.txt", ["nothing to see"]);
    const head = commitAll("feat: clean");
    const result = runScript(`--range=${base}..${head}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("privacy history check passed: 1 commit(s) scanned");
  });

  it("exits 2 with the usage line on bad arguments", () => {
    gitInit();
    const result = runScript("--range", "not-a-range");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("exits 2 when git cannot resolve the range", () => {
    const base = gitInitWithBase();
    const result = runScript("--range", `${base}..no-such-branch`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("privacy check could not run");
  });
});
