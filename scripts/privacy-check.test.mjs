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
  addedPaths,
  AUTHOR_LABELS,
  AUTHOR_RULE,
  authorProblems,
  checkRange,
  checkRepository,
  COMMIT_MESSAGE_LABEL,
  DENYLIST_ENV,
  formatResult,
  headerPath,
  isAllowedAuthorEmail,
  isAllowedEmail,
  listRangeCommits,
  loadDenylist,
  parseArgs,
  parseDenylist,
  parseNameStatus,
  PATH_LINE,
  pathFindings,
  REDACTED,
  scanPatch,
  scanPath,
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
let savedDenylistEnv;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "privacy-check-"));
  // A developer may have the CI variable set; the tests must not depend on it.
  savedDenylistEnv = process.env[DENYLIST_ENV];
  delete process.env[DENYLIST_ENV];
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  if (savedDenylistEnv === undefined) delete process.env[DENYLIST_ENV];
  else process.env[DENYLIST_ENV] = savedDenylistEnv;
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

/** Run the script in the temporary repository. The denylist variable is unset unless given. */
function runScriptWithEnv(extraEnv, ...args) {
  const env = { ...process.env };
  delete env[DENYLIST_ENV];
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: tempRoot,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
}

function runScript(...args) {
  return runScriptWithEnv({}, ...args);
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
      expect(parseArgs(args)).toEqual({
        mode: "range",
        range: "abc123..def456",
        strictAuthors: false,
      });
    },
  );

  it.each([
    [["--range", "abc123..def456", "--strict-authors"]],
    [["--strict-authors", "--range=abc123..def456"]],
  ])("reads --strict-authors from %j", (args) => {
    expect(parseArgs(args)).toEqual({
      mode: "range",
      range: "abc123..def456",
      strictAuthors: true,
    });
  });

  it.each([
    [["--range"]],
    [["--unknown"]],
    [["--range", "a..b", "extra"]],
    [["--range", "-a..b"]],
    [["--range=--output=x..y"]],
    [["--range", "single-revision"]],
    [["--range", "a.. b"]],
    [["--range="]],
    [["--strict-authors"]],
    [["--range", "a..b", "--strict-authors", "--strict-authors"]],
    [["--range", "a..b", "--range", "c..d"]],
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
    expect(checkRange(tempRoot, `${base}..${head}`)).toEqual({
      commits: 1,
      findings: [],
      authorWarnings: [],
    });
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

// ---------------------------------------------------------------------------------------
// Extra patterns from the environment, file paths and commit addresses (#57).

describe("parseDenylist", () => {
  it("builds one case-insensitive rule per pattern line and skips comments and blanks", () => {
    const rules = parseDenylist("# comment\n\nsynthetic-codename\r\nother-codename\n", "SOURCE");
    expect(rules).toHaveLength(2);
    expect(rules.every((rule) => rule.id === "denylist")).toBe(true);
    expect(scanText("about SYNTHETIC-CODENAME", rules)).toEqual([{ line: 1, rule: "denylist" }]);
  });

  it("reports an invalid pattern by source and line number only", () => {
    const secretPattern = "synthetic-secret-codename (";
    let message = "";
    try {
      parseDenylist(`ok\n# note\n${secretPattern}`, "SOURCE");
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe("SOURCE:3: not a valid regular expression");
    expect(message).not.toContain("synthetic-secret-codename");
  });

  it.each(["a*", "(?:)", "x?"])("rejects %j, which matches the empty string", (pattern) => {
    expect(() => parseDenylist(pattern, "SOURCE")).toThrow("SOURCE:1: matches the empty string");
  });
});

describe("loadDenylist", () => {
  it("returns nothing without the file or the variable", () => {
    expect(loadDenylist(tempRoot, {})).toEqual([]);
    expect(loadDenylist(tempRoot, { [DENYLIST_ENV]: "" })).toEqual([]);
  });

  it("applies the file and the environment variable together", () => {
    writeFixture(".privacy-denylist.local", ["file-codename"]);
    const rules = loadDenylist(tempRoot, { [DENYLIST_ENV]: "# from CI\nenv-codename\n" });
    expect(rules).toHaveLength(2);
    expect(scanText("file-codename\nenv-codename\nclean", rules)).toEqual([
      { line: 1, rule: "denylist" },
      { line: 2, rule: "denylist" },
    ]);
  });

  it("names the variable and the line of a bad pattern from the environment", () => {
    expect(() => loadDenylist(tempRoot, { [DENYLIST_ENV]: "fine\n[unclosed" })).toThrow(
      `${DENYLIST_ENV}:2: not a valid regular expression`,
    );
  });
});

describe("isAllowedAuthorEmail", () => {
  it.each([
    "12345+synthetic-user@users.noreply.github.com",
    "noreply" + "@" + "github.com",
    "tester@example.com",
    "",
  ])("allows %j", (address) => {
    expect(isAllowedAuthorEmail(address)).toBe(true);
  });

  it("does not allow a personal-looking address", () => {
    expect(isAllowedAuthorEmail(planted.email)).toBe(false);
  });
});

describe("scanPath", () => {
  it("returns no rules and the path unchanged when nothing matches", () => {
    expect(scanPath("packages/core/src/widget.ts", RULES)).toEqual({
      rules: [],
      redacted: "packages/core/src/widget.ts",
    });
  });

  it("redacts every matched part and lists each rule once", () => {
    const denylist = parseDenylist("synthetic-codename", "SOURCE");
    const path = `docs/synthetic-codename/${planted.email}/synthetic-codename.md`;
    const result = scanPath(path, [...RULES, ...denylist]);
    expect(result.rules).toEqual(["email", "denylist"]);
    expect(result.redacted).toBe(`docs/${REDACTED}/${REDACTED}/${REDACTED}.md`);
    expect(result.redacted).not.toContain("synthetic-codename");
    expect(result.redacted).not.toContain(planted.email);
  });

  it("merges overlapping matches of different rules into one redaction", () => {
    const denylist = parseDenylist("synthetic\\.person", "SOURCE");
    const result = scanPath(`notes/${planted.email}/a.txt`, [...RULES, ...denylist]);
    expect(result.rules).toEqual(["email", "denylist"]);
    expect(result.redacted).toBe(`notes/${REDACTED}/a.txt`);
  });

  it("keeps allowed addresses", () => {
    expect(scanPath("docs/docs@example.com/readme.txt", RULES).rules).toEqual([]);
  });
});

describe("pathFindings", () => {
  it("returns one finding per rule at the path line with the path redacted", () => {
    const denylist = parseDenylist("synthetic-codename", "SOURCE");
    expect(pathFindings("src/synthetic-codename.ts", [...RULES, ...denylist])).toEqual([
      { file: `src/${REDACTED}.ts`, line: PATH_LINE, rule: "denylist" },
    ]);
    expect(pathFindings("src/widget.ts", RULES)).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  it("returns added paths and the new side of renames and copies", () => {
    const output = [
      "A",
      "src/new file.ts",
      "M",
      "src/changed.ts",
      "D",
      "src/gone.ts",
      "R087",
      "src/old-name.ts",
      "src/new-name.ts",
      "C100",
      "src/source.ts",
      "src/copy.ts",
      "",
    ].join("\0");
    expect(parseNameStatus(output)).toEqual(["src/new file.ts", "src/new-name.ts", "src/copy.ts"]);
  });

  it("returns nothing for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("checkRepository file paths", () => {
  it("flags a matching path, redacted, and names a matching file's content findings redacted", () => {
    gitInit();
    writeFixture(".privacy-denylist.local", ["synthetic-codename"]);
    writeFixture("docs/synthetic-codename/notes.txt", ["clean", planted["github-token"]]);
    const result = checkRepository(tempRoot);
    expect(result.findings).toEqual([
      { file: `docs/${REDACTED}/notes.txt`, line: PATH_LINE, rule: "denylist" },
      { file: `docs/${REDACTED}/notes.txt`, line: 2, rule: "github-token" },
    ]);
  });

  it("checks the path of a binary file", () => {
    gitInit();
    const fullPath = join(tempRoot, "assets", planted.email, "blob.bin");
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, Buffer.from([0, 1, 2, 3]));
    expect(checkRepository(tempRoot).findings).toEqual([
      { file: `assets/${REDACTED}/blob.bin`, line: PATH_LINE, rule: "email" },
    ]);
  });

  it("applies patterns from the environment through the options", () => {
    gitInit();
    writeFixture("notes.txt", ["about env-codename"]);
    expect(checkRepository(tempRoot, { env: {} }).findings).toEqual([]);
    expect(checkRepository(tempRoot, { env: { [DENYLIST_ENV]: "env-codename" } }).findings).toEqual(
      [{ file: "notes.txt", line: 1, rule: "denylist" }],
    );
  });
});

/** Commit everything with the given author and committer addresses. */
function commitAs(message, { author, committer }) {
  git("add", "--all");
  const result = spawnSync(
    "git",
    [...GIT_ISOLATION, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message],
    {
      cwd: tempRoot,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_EMAIL: committer },
    },
  );
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`);
  return git("rev-parse", "HEAD");
}

describe("addedPaths", () => {
  it("lists added and renamed paths, not modified or deleted ones", () => {
    gitInitWithBase();
    writeFixture("src/keep.txt", ["first"]);
    writeFixture("src/old-name.txt", ["a stable body", "that is long enough", "to be a rename"]);
    writeFixture("src/remove.txt", ["bye"]);
    commitAll("feat: files");
    writeFixture("src/keep.txt", ["second"]);
    rmSync(join(tempRoot, "src/old-name.txt"));
    writeFixture("src/new-name.txt", ["a stable body", "that is long enough", "to be a rename"]);
    rmSync(join(tempRoot, "src/remove.txt"));
    writeFixture("src/added.txt", ["new"]);
    const head = commitAll("refactor: rename");
    expect(addedPaths(tempRoot, head).sort()).toEqual(["src/added.txt", "src/new-name.txt"]);
  });

  it("lists the files of a root commit", () => {
    gitInit();
    const root = commitAll("chore: root");
    expect(addedPaths(tempRoot, root)).toEqual([".gitignore"]);
  });
});

describe("authorProblems", () => {
  it("names the author and the committer separately", () => {
    gitInitWithBase();
    const noreply = "12345+synthetic-user@users.noreply.github.com";
    const both = commitAs("a", { author: planted.email, committer: planted.email });
    const authorOnly = commitAs("b", { author: planted.email, committer: noreply });
    const committerOnly = commitAs("c", { author: noreply, committer: planted.email });
    const neither = commitAs("d", { author: noreply, committer: "tester@example.com" });
    expect(authorProblems(tempRoot, both)).toEqual(["author", "committer"]);
    expect(authorProblems(tempRoot, authorOnly)).toEqual(["author"]);
    expect(authorProblems(tempRoot, committerOnly)).toEqual(["committer"]);
    expect(authorProblems(tempRoot, neither)).toEqual([]);
  });
});

describe("checkRange file paths and authors", () => {
  it("flags an added path and a renamed path, redacted", () => {
    const base = gitInitWithBase();
    writeFixture(".privacy-denylist.local", ["synthetic-codename"]);
    writeFixture("src/synthetic-codename.txt", ["clean body"]);
    const added = commitAll("feat: add");
    writeFixture("src/plain.txt", ["another clean body", "with a few lines", "to rename"]);
    commitAll("feat: plain");
    rmSync(join(tempRoot, "src/plain.txt"));
    writeFixture("src/synthetic-codename-2.txt", [
      "another clean body",
      "with a few lines",
      "to rename",
    ]);
    const renamed = commitAll("refactor: rename");
    const result = checkRange(tempRoot, `${base}..${renamed}`);
    expect(result.findings).toEqual([
      {
        commit: added.slice(0, 12),
        file: `src/${REDACTED}.txt`,
        line: PATH_LINE,
        rule: "denylist",
      },
      {
        commit: renamed.slice(0, 12),
        file: `src/${REDACTED}-2.txt`,
        line: PATH_LINE,
        rule: "denylist",
      },
    ]);
  });

  it("names a content finding in a matching path redacted", () => {
    const base = gitInitWithBase();
    writeFixture("src/synthetic-codename.txt", ["clean"]);
    commitAll("feat: add");
    writeFixture("src/synthetic-codename.txt", ["clean", planted["aws-access-key-id"]]);
    const head = commitAll("feat: change");
    // The path is only flagged when the denylist names it; it was added before this range.
    const env = { [DENYLIST_ENV]: "synthetic-codename" };
    const previous = git("rev-parse", "HEAD~1");
    expect(checkRange(tempRoot, `${previous}..${head}`, { env }).findings).toEqual([
      {
        commit: head.slice(0, 12),
        file: `src/${REDACTED}.txt`,
        line: 2,
        rule: "aws-access-key-id",
      },
    ]);
    expect(checkRange(tempRoot, `${base}..${head}`, { env }).findings).toHaveLength(2);
  });

  it("warns about non-noreply addresses by default and fails on them with strictAuthors", () => {
    const base = gitInitWithBase();
    writeFixture("a.txt", ["clean"]);
    const personal = commitAs("feat: a", { author: planted.email, committer: planted.email });
    writeFixture("b.txt", ["clean"]);
    const head = commitAll("feat: b");

    const loose = checkRange(tempRoot, `${base}..${head}`);
    expect(loose.findings).toEqual([]);
    expect(loose.authorWarnings).toEqual([
      { commit: personal.slice(0, 12), role: "author" },
      { commit: personal.slice(0, 12), role: "committer" },
    ]);

    const strict = checkRange(tempRoot, `${base}..${head}`, { strictAuthors: true });
    expect(strict.authorWarnings).toEqual([]);
    expect(strict.findings).toEqual([
      {
        commit: personal.slice(0, 12),
        file: AUTHOR_LABELS.author,
        line: PATH_LINE,
        rule: AUTHOR_RULE,
      },
      {
        commit: personal.slice(0, 12),
        file: AUTHOR_LABELS.committer,
        line: PATH_LINE,
        rule: AUTHOR_RULE,
      },
    ]);
  });

  it("checks the addresses of a merge commit", () => {
    const base = gitInitWithBase();
    git("checkout", "--quiet", "-b", "side");
    writeFixture("side.txt", ["side"]);
    commitAll("feat: side");
    git("checkout", "--quiet", "base-branch");
    writeFixture("main.txt", ["main"]);
    commitAll("feat: main");
    const result = spawnSync(
      "git",
      [...GIT_ISOLATION, "merge", "--quiet", "--no-ff", "--no-edit", "side"],
      {
        cwd: tempRoot,
        encoding: "utf8",
        env: { ...process.env, GIT_COMMITTER_EMAIL: planted.email },
      },
    );
    expect(result.status).toBe(0);
    const merge = git("rev-parse", "HEAD");
    expect(checkRange(tempRoot, `${base}..${merge}`).authorWarnings).toEqual([
      { commit: merge.slice(0, 12), role: "committer" },
    ]);
  });
});

describe("formatResult", () => {
  it("formats tree findings and a failing summary", () => {
    const out = formatResult("tree", {
      scanned: 3,
      findings: [
        { file: "a.txt", line: 2, rule: "email" },
        { file: `docs/${REDACTED}.md`, line: PATH_LINE, rule: "denylist" },
      ],
    });
    expect(out).toEqual({
      errors: ["a.txt:2: email", `docs/${REDACTED}.md:0: denylist`],
      warnings: [],
      summary: "privacy check failed: 2 finding(s)",
      failed: true,
    });
  });

  it("formats author warnings with the sha and role only, and a passing summary", () => {
    const out = formatResult("range", {
      commits: 2,
      findings: [],
      authorWarnings: [
        { commit: "aaaaaaaaaaaa", role: "author" },
        { commit: "aaaaaaaaaaaa", role: "committer" },
        { commit: "bbbbbbbbbbbb", role: "author" },
      ],
    });
    expect(out.failed).toBe(false);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([
      "warning: aaaaaaaaaaaa: author email is not a noreply address",
      "warning: aaaaaaaaaaaa: committer email is not a noreply address",
      "warning: bbbbbbbbbbbb: author email is not a noreply address",
      "warning: 2 commit(s) with an author or committer email that is not a noreply address (--strict-authors makes this a failure)",
    ]);
    expect(out.summary).toBe("privacy history check passed: 2 commit(s) scanned, 0 findings");
  });

  it("prefixes range findings with the commit", () => {
    const out = formatResult("range", {
      commits: 1,
      findings: [
        { commit: "cccccccccccc", file: AUTHOR_LABELS.author, line: 0, rule: AUTHOR_RULE },
      ],
    });
    expect(out.errors).toEqual([`cccccccccccc:${AUTHOR_LABELS.author}:0: ${AUTHOR_RULE}`]);
    expect(out.summary).toBe("privacy history check failed: 1 finding(s)");
  });
});

describe("entry point: paths, environment patterns and authors", () => {
  it("prints a path finding without the matched text", () => {
    gitInit();
    writeFixture(`notes/${planted.email}/a.txt`, ["clean"]);
    const result = runScript();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`notes/${REDACTED}/a.txt:0: email`);
    expect(result.stderr).not.toContain(planted.email);
  });

  it("applies patterns from the environment variable and never prints them", () => {
    gitInit();
    writeFixture("notes.txt", ["about env-codename"]);
    expect(runScript().status).toBe(0);
    const result = runScriptWithEnv({ [DENYLIST_ENV]: "env-codename" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("notes.txt:1: denylist");
    expect(result.stderr + result.stdout).not.toContain("env-codename");
  });

  it("exits 2 on a bad pattern in the variable, naming the line only", () => {
    gitInit();
    const result = runScriptWithEnv({ [DENYLIST_ENV]: "ok\nenv-codename (" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${DENYLIST_ENV}:2: not a valid regular expression`);
    expect(result.stderr).not.toContain("env-codename");
  });

  it("warns about authors without the address and fails with --strict-authors", () => {
    const base = gitInitWithBase();
    writeFixture("a.txt", ["clean"]);
    const head = commitAs("feat: a", { author: planted.email, committer: "tester@example.com" });
    const short = head.slice(0, 12);

    const loose = runScript("--range", `${base}..${head}`);
    expect(loose.status).toBe(0);
    expect(loose.stderr).toContain(`warning: ${short}: author email is not a noreply address`);
    expect(loose.stdout).toContain("privacy history check passed: 1 commit(s) scanned");
    expect(loose.stderr + loose.stdout).not.toContain(planted.email);

    const strict = runScript("--range", `${base}..${head}`, "--strict-authors");
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain(`${short}:${AUTHOR_LABELS.author}:0: ${AUTHOR_RULE}`);
    expect(strict.stderr).not.toContain(planted.email);
  });

  it("exits 2 when --strict-authors is given without --range", () => {
    gitInit();
    const result = runScript("--strict-authors");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--strict-authors needs --range");
  });
});
