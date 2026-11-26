// Tests for scripts/privacy-check.mjs.
// Planted strings are assembled at run time from fragments, so this file never contains a
// literal match. Every fixture is written into a temporary folder that the test removes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRepository, isAllowedEmail, scanText, RULES } from "./privacy-check.mjs";

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

function runScript() {
  return spawnSync(process.execPath, [scriptPath], { cwd: tempRoot, encoding: "utf8" });
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
