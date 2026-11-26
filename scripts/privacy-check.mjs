#!/usr/bin/env node
// Privacy check for the repository (npm run privacy).
//
// Scans every file that git would track or that is untracked but not ignored, and exits
// with status 1 on any finding. Each finding prints file:line and the rule id. The matched
// text is never printed, so the output of a failing check cannot leak the value.
//
// Extra patterns: one regular expression per line in .privacy-denylist.local at the
// repository root. That file is git-ignored. Patterns are matched case-insensitively.
// Blank lines and lines starting with "#" are ignored.
//
// Rule patterns are written as regex literals whose text does not contain the literal
// strings they detect, so this file does not flag itself.
//
// History mode: node scripts/privacy-check.mjs --range <base>..<head>
// (or npm run privacy -- --range <base>..<head>). Scans what the commits in the range add:
// every added line of every non-merge commit, and every commit message. A value that one
// commit adds and a later commit removes is not in the tree any more, but it is still in the
// history that a merge publishes, so the tree scan alone cannot see it. Findings print as
// <short sha>:<file>:<line>: <rule>, again without the matched text. CI runs both modes.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DENYLIST_FILE = ".privacy-denylist.local";

const BINARY_PROBE_BYTES = 8000;

/** @type {{ id: string, description: string, pattern: RegExp, allow?: (match: string) => boolean }[]} */
export const RULES = [
  {
    id: "home-path-macos",
    description: "macOS home-folder path",
    // A user folder name right after the prefix. Placeholders such as <name> are not flagged.
    pattern: /\/Users\/[^/\s"'`<>]+/g,
  },
  {
    id: "home-path-linux",
    description: "Linux home-folder path",
    pattern: /\/home\/[^/\s"'`<>]+/g,
  },
  {
    id: "home-path-windows",
    description: "Windows home-folder path",
    // Matches single backslashes, JSON-escaped double backslashes and forward slashes.
    pattern: /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"'`<>]+/g,
  },
  {
    id: "email",
    description: "email address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: isAllowedEmail,
  },
  {
    id: "github-token",
    description: "GitHub token",
    pattern: /\bgh[opsu]_[A-Za-z0-9]{8,}/g,
  },
  {
    id: "anthropic-key",
    description: "Anthropic API key",
    pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: "digitalocean-token",
    description: "DigitalOcean token",
    pattern: /dop_v1_[A-Za-z0-9]{8,}/g,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: "private-key-block",
    description: "private key block",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
];

/**
 * Noreply addresses and the example.com domain are fixtures, not personal data.
 * @param {string} address
 */
export function isAllowedEmail(address) {
  const lower = address.toLowerCase();
  if (lower.includes("noreply") || lower.includes("no-reply")) return true;
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return domain === "example.com" || domain.endsWith(".example.com");
}

/**
 * Read the git-ignored denylist. A missing file is not an error.
 * @param {string} root
 * @returns {{ id: string, description: string, pattern: RegExp }[]}
 */
export function loadDenylist(root) {
  let text;
  try {
    text = readFileSync(join(root, DENYLIST_FILE), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const rules = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    let pattern;
    try {
      pattern = new RegExp(line, "gi");
    } catch {
      // Report the line number only: the pattern itself is private.
      throw new Error(`${DENYLIST_FILE}:${index + 1}: not a valid regular expression`);
    }
    rules.push({ id: "denylist", description: "denylist pattern", pattern });
  });
  return rules;
}

/**
 * List tracked and untracked, non-ignored files, relative to the root.
 * @param {string} root
 * @returns {string[]}
 */
export function listFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(output.split("\0").filter((name) => name !== ""))];
}

/**
 * Scan one text and return findings with 1-based line numbers.
 * @param {string} text
 * @param {typeof RULES} rules
 * @returns {{ line: number, rule: string }[]}
 */
export function scanText(text, rules) {
  const findings = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const match of lineText.matchAll(rule.pattern)) {
        if (rule.allow && rule.allow(match[0])) continue;
        findings.push({ line: index + 1, rule: rule.id });
        break;
      }
    }
  });
  return findings;
}

/**
 * Check every listed file under root. Files that are missing on disk (deleted but still
 * in the index) and binary files are skipped.
 * @param {string} root
 * @param {string[]} files
 * @param {typeof RULES} rules
 */
export function scanFiles(root, files, rules) {
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(join(root, file));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
    scanned += 1;
    for (const hit of scanText(buffer.toString("utf8"), rules)) {
      findings.push({ file, line: hit.line, rule: hit.rule });
    }
  }
  return { scanned, findings };
}

/**
 * Run the whole check for a repository root.
 * @param {string} root
 */
export function checkRepository(root) {
  const rules = [...RULES, ...loadDenylist(root)];
  const files = listFiles(root);
  return scanFiles(root, files, rules);
}

/** Label used in place of a file name for findings in a commit message. */
export const COMMIT_MESSAGE_LABEL = "(commit message)";

export const USAGE = "usage: node scripts/privacy-check.mjs [--range <base>..<head>]";

/**
 * Parse the command-line arguments (without node and the script path).
 * @param {string[]} args
 * @returns {{ mode: "tree" } | { mode: "range", range: string }}
 */
export function parseArgs(args) {
  if (args.length === 0) return { mode: "tree" };
  let range;
  if (args.length === 1 && args[0].startsWith("--range=")) {
    range = args[0].slice("--range=".length);
  } else if (args.length === 2 && args[0] === "--range") {
    range = args[1];
  } else {
    throw new Error(USAGE);
  }
  // A leading "-" would reach git as an option, and the range must name two ends.
  if (range === "" || range.startsWith("-") || !range.includes("..") || /\s/.test(range)) {
    throw new Error(`not a commit range of the form <base>..<head>\n${USAGE}`);
  }
  return { mode: "range", range };
}

/**
 * Turn the path on a "+++ " diff header line into a repository-relative path.
 * Returns null for "/dev/null" (the file was deleted).
 * @param {string} header the text after "+++ "
 */
export function headerPath(header) {
  // git appends a tab after names that contain a space.
  let path = header.replace(/\t$/, "");
  if (path === "/dev/null") return null;
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return path.startsWith("b/") ? path.slice(2) : path;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Scan the added lines of a unified diff. Line numbers are the line in the new file.
 * Removed lines, context lines and file headers are not scanned.
 * @param {string} patch output of `git show` / `git diff` with a/ and b/ prefixes
 * @param {typeof RULES} rules
 * @returns {{ file: string, line: number, rule: string }[]}
 */
export function scanPatch(patch, rules) {
  const findings = [];
  let file = null;
  let inHunk = false;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    const hunk = HUNK_HEADER.exec(text);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    if (!inHunk) {
      // File header: only the "+++ " line names the new path.
      if (text.startsWith("+++ ")) file = headerPath(text.slice(4));
      continue;
    }
    if (text.startsWith("+")) {
      if (file !== null) {
        for (const hit of scanText(text.slice(1), rules)) {
          findings.push({ file, line: newLine, rule: hit.rule });
        }
      }
      newLine += 1;
    } else if (text.startsWith(" ")) {
      newLine += 1;
    }
    // "-" lines and "\ No newline at end of file" do not move the new-file counter.
  }
  return findings;
}

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * List the commits in a range, oldest first, and whether each one is a merge.
 * @param {string} root
 * @param {string} range
 * @returns {{ sha: string, merge: boolean }[]}
 */
export function listRangeCommits(root, range) {
  const output = git(root, ["rev-list", "--reverse", "--parents", range, "--"]);
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, ...parents] = line.split(" ");
      return { sha, merge: parents.length > 1 };
    });
}

/**
 * Scan what the commits in a range add: the message of every commit and the added lines of
 * every non-merge commit. The commits a merge brings in are either in the range themselves
 * or already on the base, so merge diffs are not scanned.
 * @param {string} root
 * @param {string} range
 */
export function checkRange(root, range) {
  const rules = [...RULES, ...loadDenylist(root)];
  const commits = listRangeCommits(root, range);
  const findings = [];
  for (const { sha, merge } of commits) {
    const commit = sha.slice(0, 12);
    const message = git(root, ["log", "-1", "--format=%B", sha, "--"]);
    for (const hit of scanText(message, rules)) {
      findings.push({ commit, file: COMMIT_MESSAGE_LABEL, line: hit.line, rule: hit.rule });
    }
    if (merge) continue;
    const patch = git(root, [
      "-c",
      "core.quotePath=false",
      "show",
      "--format=",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=0",
      "-M",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      sha,
      "--",
    ]);
    for (const hit of scanPatch(patch, rules)) {
      findings.push({ commit, ...hit });
    }
  }
  return { commits: commits.length, findings };
}

/** @param {string[]} args */
function main(args) {
  const root = process.cwd();
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = options.mode === "range" ? checkRange(root, options.range) : checkRepository(root);
  } catch (error) {
    console.error(`privacy check could not run: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  for (const finding of result.findings) {
    const prefix = "commit" in finding ? `${finding.commit}:` : "";
    console.error(`${prefix}${finding.file}:${finding.line}: ${finding.rule}`);
  }
  const label = options.mode === "range" ? "privacy history check" : "privacy check";
  if (result.findings.length > 0) {
    console.error(`${label} failed: ${result.findings.length} finding(s)`);
    process.exitCode = 1;
    return;
  }
  const count =
    options.mode === "range"
      ? `${result.commits} commit(s) scanned`
      : `${result.scanned} file(s) scanned`;
  console.log(`${label} passed: ${count}, 0 findings`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main(process.argv.slice(2));
