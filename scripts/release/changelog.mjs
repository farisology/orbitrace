#!/usr/bin/env node
// CHANGELOG.md in the Keep a Changelog 1.1.0 format (docs/releasing.md):
//
//   node scripts/release/changelog.mjs check [--version <v>]   exit 1 if the format is wrong
//                                                              (or, with --version, <v> has no section)
//   node scripts/release/changelog.mjs notes <v>               print the section of <v> (release notes)
//   node scripts/release/changelog.mjs release <v> [--date YYYY-MM-DD]
//                                                              move Unreleased into a new <v> section
//
// `release` writes CHANGELOG.md; the other two only read it.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, REPO_URL } from "./lib.mjs";
import { isValidVersion } from "./version.mjs";

export const UNRELEASED = "Unreleased";

/** The change types Keep a Changelog 1.1.0 defines, in its order. */
export const CHANGE_TYPES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const SECTION_HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/;
const LINK_REFERENCE = /^\[([^\]]+)\]: (\S+)$/;

/**
 * Compare two semantic versions: negative when a < b, zero when equal, positive when a > b.
 * Build metadata is ignored, as Semantic Versioning 2.0.0 says.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const split = (version) => {
    const [core, pre] = version.split("+")[0].split(/-(.*)/s);
    return { numbers: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Split a changelog into its parts.
 * @param {string} text
 * @returns {{ head: string[], sections: { name: string, date: string | null, line: number, body: string[] }[], links: { name: string, url: string }[], stray: { line: number, text: string }[] }}
 */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  /** @type {string[]} */
  const head = [];
  /** @type {{ name: string, date: string | null, line: number, body: string[] }[]} */
  const sections = [];
  /** @type {{ name: string, url: string }[]} */
  const links = [];
  /** @type {{ line: number, text: string }[]} */
  const stray = [];
  lines.forEach((line, index) => {
    const link = LINK_REFERENCE.exec(line);
    if (link) {
      links.push({ name: link[1], url: link[2] });
      return;
    }
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      sections.push({ name: heading[1], date: heading[2] ?? null, line: index + 1, body: [] });
      return;
    }
    if (line.startsWith("## ")) stray.push({ line: index + 1, text: line });
    if (sections.length === 0) head.push(line);
    else sections[sections.length - 1].body.push(line);
  });
  return { head, sections, links, stray };
}

/** True for a real calendar date in YYYY-MM-DD form. */
function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Everything wrong with a changelog's format.
 * @param {string} text
 * @returns {string[]}
 */
export function validateChangelog(text) {
  const { head, sections, stray } = parseChangelog(text);
  const errors = [];
  if (head.find((line) => line.trim() !== "") !== "# Changelog") {
    errors.push('the first line must be "# Changelog"');
  }
  for (const { line } of stray) {
    errors.push(
      `line ${line}: a "## " heading must be "## [Unreleased]" or "## [x.y.z] - YYYY-MM-DD"`,
    );
  }
  if (sections[0]?.name !== UNRELEASED) errors.push('the first section must be "## [Unreleased]"');
  const seen = new Set();
  let previous = null;
  for (const section of sections) {
    if (seen.has(section.name))
      errors.push(`line ${section.line}: section [${section.name}] is repeated`);
    seen.add(section.name);
    if (section.name === UNRELEASED) {
      if (section.date !== null) errors.push(`line ${section.line}: [Unreleased] takes no date`);
      if (section !== sections[0])
        errors.push(`line ${section.line}: [Unreleased] must come first`);
    } else {
      if (!isValidVersion(section.name)) {
        errors.push(`line ${section.line}: [${section.name}] is not a semantic version`);
        continue;
      }
      if (section.date === null || !isDate(section.date)) {
        errors.push(`line ${section.line}: [${section.name}] needs a date as YYYY-MM-DD`);
      }
      if (previous !== null && compareVersions(previous, section.name) <= 0) {
        errors.push(`line ${section.line}: [${section.name}] must come below newer versions`);
      }
      previous = section.name;
    }
    section.body.forEach((line, offset) => {
      const type = /^### (.*)$/.exec(line);
      if (type && !CHANGE_TYPES.includes(type[1])) {
        errors.push(
          `line ${section.line + offset + 1}: "### ${type[1]}" is not one of ${CHANGE_TYPES.join(", ")}`,
        );
      }
    });
  }
  return errors;
}

/**
 * The body of one section, trimmed of blank lines at both ends. Throws when the section is
 * missing or empty.
 * @param {string} text
 * @param {string} name a version, or "Unreleased"
 */
export function sectionNotes(text, name) {
  const section = parseChangelog(text).sections.find((candidate) => candidate.name === name);
  if (!section) throw new Error(`CHANGELOG.md has no section for this version`);
  const body = section.body.join("\n").trim();
  if (body === "") throw new Error(`the CHANGELOG.md section is empty`);
  return body;
}

/**
 * Move the Unreleased entries into a new section for `version`, and update the link references
 * at the bottom (compare links between tags, as Keep a Changelog shows).
 * @param {string} text
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @param {string} [repoUrl]
 */
export function releaseChangelog(text, version, date, repoUrl = REPO_URL) {
  if (!isValidVersion(version)) throw new Error("not a valid semantic version");
  if (!isDate(date)) throw new Error("the date must be YYYY-MM-DD");
  const errors = validateChangelog(text);
  if (errors.length > 0) throw new Error(`CHANGELOG.md is not valid: ${errors[0]}`);
  const { head, sections, links } = parseChangelog(text);
  if (sections.some((section) => section.name === version)) {
    throw new Error("CHANGELOG.md already has a section for this version");
  }
  const [unreleased, ...released] = sections;
  const entries = unreleased.body.join("\n").trim();
  if (entries === "") throw new Error("the Unreleased section is empty: nothing to release");
  const previous = released[0]?.name ?? null;
  if (previous !== null && compareVersions(version, previous) <= 0) {
    throw new Error("the new version must be newer than the latest released version");
  }

  const trimEnd = (lines) => {
    const copy = [...lines];
    while (copy.length > 0 && copy[copy.length - 1].trim() === "") copy.pop();
    return copy;
  };
  const out = [...trimEnd(head), "", `## [${UNRELEASED}]`, "", `## [${version}] - ${date}`, ""];
  out.push(entries, "");
  for (const section of released) {
    const heading = `## [${section.name}]${section.date ? ` - ${section.date}` : ""}`;
    out.push(heading, ...trimEnd(section.body), "");
  }
  const newLinks = [
    { name: UNRELEASED, url: `${repoUrl}/compare/v${version}...HEAD` },
    {
      name: version,
      url:
        previous === null
          ? `${repoUrl}/releases/tag/v${version}`
          : `${repoUrl}/compare/v${previous}...v${version}`,
    },
    ...links.filter((link) => link.name !== UNRELEASED && link.name !== version),
  ];
  for (const link of newLinks) out.push(`[${link.name}]: ${link.url}`);
  return `${out.join("\n")}\n`;
}

/** Today's date in UTC as YYYY-MM-DD. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run one command against a changelog file. Returns the exit code and the lines to print.
 * @param {string[]} args
 * @param {string} file
 * @returns {{ code: number, out: string[], err: string[] }}
 */
export function run(args, file = join(REPO_ROOT, "CHANGELOG.md")) {
  const [command, ...rest] = args;
  const option = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const usage = {
    code: 2,
    out: [],
    err: [
      "usage: node scripts/release/changelog.mjs check [--version <v>] | notes <v> | release <v> [--date YYYY-MM-DD]",
    ],
  };
  const text = readFileSync(file, "utf8");
  if (command === "check") {
    const version = option("--version");
    if (rest.length !== 0 && !(rest.length === 2 && version !== undefined)) return usage;
    if (version !== undefined && !isValidVersion(version)) {
      return { code: 1, out: [], err: ["changelog: not a valid semantic version"] };
    }
    const errors = validateChangelog(text);
    if (errors.length === 0 && version !== undefined) {
      try {
        sectionNotes(text, version);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length > 0) return { code: 1, out: [], err: errors.map((e) => `changelog: ${e}`) };
    return { code: 0, out: ["changelog: ok"], err: [] };
  }
  if (command === "notes" && rest.length === 1) {
    if (!isValidVersion(rest[0]) && rest[0] !== UNRELEASED) {
      return { code: 1, out: [], err: ["changelog: not a valid semantic version"] };
    }
    try {
      return { code: 0, out: [sectionNotes(text, rest[0])], err: [] };
    } catch (error) {
      return {
        code: 1,
        out: [],
        err: [`changelog: ${error instanceof Error ? error.message : error}`],
      };
    }
  }
  if (command === "release" && (rest.length === 1 || (rest.length === 3 && option("--date")))) {
    try {
      writeFileSync(file, releaseChangelog(text, rest[0], option("--date") ?? today()));
      return { code: 0, out: ["changelog: moved Unreleased into a new section"], err: [] };
    } catch (error) {
      return {
        code: 1,
        out: [],
        err: [`changelog: ${error instanceof Error ? error.message : error}`],
      };
    }
  }
  return usage;
}

function main() {
  try {
    const { code, out, err } = run(process.argv.slice(2));
    for (const line of out) console.log(line);
    for (const line of err) console.error(line);
    process.exitCode = code;
  } catch (error) {
    console.error(`changelog: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
