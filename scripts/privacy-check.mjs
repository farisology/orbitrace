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

function main() {
  const root = process.cwd();
  let result;
  try {
    result = checkRepository(root);
  } catch (error) {
    console.error(`privacy check could not run: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  for (const finding of result.findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
  }
  if (result.findings.length > 0) {
    console.error(`privacy check failed: ${result.findings.length} finding(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`privacy check passed: ${result.scanned} file(s) scanned, 0 findings`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
