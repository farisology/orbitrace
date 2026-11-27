#!/usr/bin/env node
// Privacy check for the repository (npm run privacy).
//
// Scans every file that git would track or that is untracked but not ignored, and exits
// with status 1 on any finding. The path of each file is scanned as well as its contents, so
// a private name in a file or folder name is caught too. Each finding prints file:line and
// the rule id. The matched text is never printed, so the output of a failing check cannot
// leak the value. Line 0 means the file's path matched; in that case the matched part of the
// path is printed as [redacted].
//
// Extra patterns: one regular expression per line, matched case-insensitively, from two
// places, and both apply when both are present:
// - .privacy-denylist.local at the repository root. That file is git-ignored.
// - The environment variable ORBITRACE_PRIVACY_DENYLIST. CI fills it from a repository
//   secret of the same name on pushes to dev only (pull requests from forks get no secrets).
// Blank lines and lines starting with "#" are ignored. A pattern that is not a valid regular
// expression, or that matches the empty string, stops the check with its source and line
// number only: the patterns are private and are never printed.
//
// Rule patterns are written as regex literals whose text does not contain the literal
// strings they detect, so this file does not flag itself.
//
// History mode: node scripts/privacy-check.mjs --range <base>..<head> [--strict-authors]
// (or npm run privacy -- --range <base>..<head>). Scans what the commits in the range add:
// every added line and every added or renamed path of every non-merge commit, and every
// commit message. A value that one commit adds and a later commit removes is not in the tree
// any more, but it is still in the history that a merge publishes, so the tree scan alone
// cannot see it. Findings print as <short sha>:<file>:<line>: <rule>, again without the
// matched text.
//
// History mode also looks at the author and committer email of every commit in the range,
// because a merge publishes them. An address that is not a noreply address (or on the
// reserved example.com domain) is a warning by default: the check prints the short sha and
// which of the two it is, never the address, and still passes. With --strict-authors such a
// commit is a finding and the check fails. CI runs both modes; the owner decides when CI
// switches to --strict-authors.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DENYLIST_FILE = ".privacy-denylist.local";

/** Environment variable with extra patterns, one regular expression per line. */
export const DENYLIST_ENV = "ORBITRACE_PRIVACY_DENYLIST";

/** Line number used for a finding in a file's path rather than in one of its lines. */
export const PATH_LINE = 0;

/** Text that replaces each matched part of a path in the output. */
export const REDACTED = "[redacted]";

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
 * Whether a commit's author or committer address may be published: a noreply address, an
 * example.com address, or no address at all.
 * @param {string} address
 */
export function isAllowedAuthorEmail(address) {
  const trimmed = address.trim();
  return trimmed === "" || isAllowedEmail(trimmed);
}

/**
 * Parse denylist text: one pattern per line, blank lines and "#" comments skipped.
 * Errors name the source and the line number only, never the pattern.
 * @param {string} text
 * @param {string} source a label for error messages: the file name or the variable name
 * @returns {{ id: string, description: string, pattern: RegExp }[]}
 */
export function parseDenylist(text, source) {
  const rules = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    let pattern;
    try {
      pattern = new RegExp(line, "gi");
    } catch {
      throw new Error(`${source}:${index + 1}: not a valid regular expression`);
    }
    // A pattern that matches the empty string would flag every line of every file.
    if (new RegExp(line, "i").test("")) {
      throw new Error(`${source}:${index + 1}: matches the empty string`);
    }
    rules.push({ id: "denylist", description: "denylist pattern", pattern });
  });
  return rules;
}

/**
 * Read the extra patterns: the git-ignored file at the root, then the environment variable.
 * A missing file or an unset or empty variable is not an error.
 * @param {string} root
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ id: string, description: string, pattern: RegExp }[]}
 */
export function loadDenylist(root, env = process.env) {
  let text = "";
  try {
    text = readFileSync(join(root, DENYLIST_FILE), "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return [
    ...parseDenylist(text, DENYLIST_FILE),
    ...parseDenylist(env[DENYLIST_ENV] ?? "", DENYLIST_ENV),
  ];
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
 * The non-allowed matches of one rule in a text, as [start, end) spans.
 * @param {string} text
 * @param {(typeof RULES)[number]} rule
 * @returns {[number, number][]}
 */
function ruleMatches(text, rule) {
  const spans = [];
  rule.pattern.lastIndex = 0;
  for (const match of text.matchAll(rule.pattern)) {
    if (match[0] === "") continue;
    if (rule.allow && rule.allow(match[0])) continue;
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
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
      if (ruleMatches(lineText, rule).length > 0) {
        findings.push({ line: index + 1, rule: rule.id });
      }
    }
  });
  return findings;
}

/**
 * Scan a repository-relative path as one piece of text. Returns the id of every rule that
 * matches, once each, and the path with every matched part replaced by REDACTED, so a
 * finding can say where it is without printing what matched.
 * @param {string} path
 * @param {typeof RULES} rules
 * @returns {{ rules: string[], redacted: string }}
 */
export function scanPath(path, rules) {
  const ids = [];
  const spans = [];
  for (const rule of rules) {
    const found = ruleMatches(path, rule);
    if (found.length === 0) continue;
    if (!ids.includes(rule.id)) ids.push(rule.id);
    spans.push(...found);
  }
  if (spans.length === 0) return { rules: [], redacted: path };
  // Merge overlapping spans, then rebuild the path around them.
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  let redacted = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    redacted += path.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  redacted += path.slice(cursor);
  return { rules: ids, redacted };
}

/**
 * Findings for one path: one per matching rule, at PATH_LINE, with the path redacted.
 * @param {string} path
 * @param {typeof RULES} rules
 * @returns {{ file: string, line: number, rule: string }[]}
 */
export function pathFindings(path, rules) {
  const { rules: ids, redacted } = scanPath(path, rules);
  return ids.map((rule) => ({ file: redacted, line: PATH_LINE, rule }));
}

/**
 * Check every listed file under root: its path, and its contents. Files that are missing on
 * disk (deleted but still in the index) and binary files have their path checked only.
 * @param {string} root
 * @param {string[]} files
 * @param {typeof RULES} rules
 */
export function scanFiles(root, files, rules) {
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    const { rules: pathRules, redacted } = scanPath(file, rules);
    for (const rule of pathRules) findings.push({ file: redacted, line: PATH_LINE, rule });
    let buffer;
    try {
      buffer = readFileSync(join(root, file));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
    scanned += 1;
    // A content finding in a file whose path also matched names the file redacted.
    for (const hit of scanText(buffer.toString("utf8"), rules)) {
      findings.push({ file: redacted, line: hit.line, rule: hit.rule });
    }
  }
  return { scanned, findings };
}

/**
 * Run the whole check for a repository root.
 * @param {string} root
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function checkRepository(root, options = {}) {
  const rules = [...RULES, ...loadDenylist(root, options.env)];
  const files = listFiles(root);
  return scanFiles(root, files, rules);
}

/** Label used in place of a file name for findings in a commit message. */
export const COMMIT_MESSAGE_LABEL = "(commit message)";

/** Labels used in place of a file name for author and committer findings. */
export const AUTHOR_LABELS = { author: "(commit author)", committer: "(commit committer)" };

/** Rule id of a commit whose author or committer address is not a noreply address. */
export const AUTHOR_RULE = "author-email";

export const USAGE =
  "usage: node scripts/privacy-check.mjs [--range <base>..<head> [--strict-authors]]";

/**
 * Parse the command-line arguments (without node and the script path).
 * @param {string[]} args
 * @returns {{ mode: "tree" } | { mode: "range", range: string, strictAuthors: boolean }}
 */
export function parseArgs(args) {
  let range;
  let strictAuthors = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--strict-authors" && !strictAuthors) {
      strictAuthors = true;
    } else if (arg.startsWith("--range=") && range === undefined) {
      range = arg.slice("--range=".length);
    } else if (arg === "--range" && range === undefined && index + 1 < args.length) {
      index += 1;
      range = args[index];
    } else {
      throw new Error(USAGE);
    }
  }
  if (range === undefined) {
    // --strict-authors only has commits to look at in history mode.
    if (strictAuthors) throw new Error(`--strict-authors needs --range\n${USAGE}`);
    return { mode: "tree" };
  }
  // A leading "-" would reach git as an option, and the range must name two ends.
  if (range === "" || range.startsWith("-") || !range.includes("..") || /\s/.test(range)) {
    throw new Error(`not a commit range of the form <base>..<head>\n${USAGE}`);
  }
  return { mode: "range", range, strictAuthors };
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
          // A path that itself matched is printed redacted, like a path finding.
          findings.push({ file: scanPath(file, rules).redacted, line: newLine, rule: hit.rule });
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
 * Parse `git diff-tree -z --name-status` output and return the paths a commit adds: the
 * path of every added file and the new path of every renamed or copied file.
 * @param {string} output
 * @returns {string[]}
 */
export function parseNameStatus(output) {
  const fields = output.split("\0");
  const paths = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index];
    if (status === "") {
      index += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      // Two paths follow: the old one and the new one.
      paths.push(fields[index + 2]);
      index += 3;
    } else {
      if (status.startsWith("A")) paths.push(fields[index + 1]);
      index += 2;
    }
  }
  return paths.filter((path) => path !== undefined && path !== "");
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
 * The paths a commit adds or renames to, relative to the repository root.
 * @param {string} root
 * @param {string} sha
 */
export function addedPaths(root, sha) {
  const output = git(root, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "-r",
    "-z",
    "-M",
    "--name-status",
    "--diff-filter=ACR",
    sha,
    "--",
  ]);
  return parseNameStatus(output);
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
 * Which of a commit's two addresses are not allowed to be published.
 * @param {string} root
 * @param {string} sha
 * @returns {("author" | "committer")[]}
 */
export function authorProblems(root, sha) {
  const [author = "", committer = ""] = git(root, ["log", "-1", "--format=%ae%x00%ce", sha, "--"])
    .replace(/\n$/, "")
    .split("\0");
  /** @type {("author" | "committer")[]} */
  const problems = [];
  if (!isAllowedAuthorEmail(author)) problems.push("author");
  if (!isAllowedAuthorEmail(committer)) problems.push("committer");
  return problems;
}

/**
 * Scan what the commits in a range add: the message of every commit, the added lines and the
 * added or renamed paths of every non-merge commit, and the author and committer addresses of
 * every commit. The commits a merge brings in are either in the range themselves or already
 * on the base, so merge diffs are not scanned.
 *
 * Address problems are returned as warnings, or as findings when strictAuthors is set.
 * Neither carries the address.
 * @param {string} root
 * @param {string} range
 * @param {{ strictAuthors?: boolean, env?: Record<string, string | undefined> }} [options]
 */
export function checkRange(root, range, options = {}) {
  const rules = [...RULES, ...loadDenylist(root, options.env)];
  const commits = listRangeCommits(root, range);
  const findings = [];
  /** @type {{ commit: string, role: "author" | "committer" }[]} */
  const authorWarnings = [];
  for (const { sha, merge } of commits) {
    const commit = sha.slice(0, 12);
    for (const role of authorProblems(root, sha)) {
      if (options.strictAuthors) {
        findings.push({ commit, file: AUTHOR_LABELS[role], line: PATH_LINE, rule: AUTHOR_RULE });
      } else {
        authorWarnings.push({ commit, role });
      }
    }
    const message = git(root, ["log", "-1", "--format=%B", sha, "--"]);
    for (const hit of scanText(message, rules)) {
      findings.push({ commit, file: COMMIT_MESSAGE_LABEL, line: hit.line, rule: hit.rule });
    }
    if (merge) continue;
    for (const path of addedPaths(root, sha)) {
      for (const hit of pathFindings(path, rules)) findings.push({ commit, ...hit });
    }
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
  return { commits: commits.length, findings, authorWarnings };
}

/**
 * The output lines of a result, without the matched text or any address.
 * @param {"tree" | "range"} mode
 * @param {{ findings: { commit?: string, file: string, line: number, rule: string }[], authorWarnings?: { commit: string, role: string }[], scanned?: number, commits?: number }} result
 * @returns {{ errors: string[], warnings: string[], summary: string, failed: boolean }}
 */
export function formatResult(mode, result) {
  const errors = result.findings.map((finding) => {
    const prefix = finding.commit !== undefined ? `${finding.commit}:` : "";
    return `${prefix}${finding.file}:${finding.line}: ${finding.rule}`;
  });
  const authorWarnings = result.authorWarnings ?? [];
  const warnings = authorWarnings.map(
    ({ commit, role }) => `warning: ${commit}: ${role} email is not a noreply address`,
  );
  if (authorWarnings.length > 0) {
    const commits = new Set(authorWarnings.map((warning) => warning.commit)).size;
    warnings.push(
      `warning: ${commits} commit(s) with an author or committer email that is not a noreply address (--strict-authors makes this a failure)`,
    );
  }
  const label = mode === "range" ? "privacy history check" : "privacy check";
  const failed = result.findings.length > 0;
  let summary;
  if (failed) {
    summary = `${label} failed: ${result.findings.length} finding(s)`;
  } else {
    const count =
      mode === "range"
        ? `${result.commits} commit(s) scanned`
        : `${result.scanned} file(s) scanned`;
    summary = `${label} passed: ${count}, 0 findings`;
  }
  return { errors, warnings, summary, failed };
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
    result =
      options.mode === "range"
        ? checkRange(root, options.range, { strictAuthors: options.strictAuthors })
        : checkRepository(root);
  } catch (error) {
    console.error(`privacy check could not run: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const { errors, warnings, summary, failed } = formatResult(options.mode, result);
  for (const line of errors) console.error(line);
  for (const line of warnings) console.error(line);
  if (failed) {
    console.error(summary);
    process.exitCode = 1;
    return;
  }
  console.log(summary);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main(process.argv.slice(2));
