#!/usr/bin/env node
// One version for every package under packages/ (docs/releasing.md):
//
//   node scripts/release/version.mjs current          print the shared version; exit 1 if they differ
//   node scripts/release/version.mjs check <version>  exit 1 unless every package has <version>
//   node scripts/release/version.mjs bump <version>   set <version> in every packages/*/package.json
//
// `bump` also sets every dependency on another workspace package to the same exact version,
// and writes nothing else. Run `npm install --package-lock-only --ignore-scripts` afterwards so
// package-lock.json records the new versions. The root package.json is the private monorepo
// root; it is never released and keeps its own version.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib.mjs";

/** Semantic Versioning 2.0.0, without a leading "v". */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * True for a Semantic Versioning 2.0.0 version such as `0.1.0` or `1.0.0-rc.1`.
 * @param {unknown} version
 */
export function isValidVersion(version) {
  return typeof version === "string" && version.length <= 64 && SEMVER.test(version);
}

/**
 * Every packages/<dir>/package.json under a root, sorted by folder name.
 * @param {string} root
 * @returns {{ dir: string, path: string, manifest: Record<string, any> }[]}
 */
export function readManifests(root) {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort()
    .map((dir) => {
      const path = join(packagesDir, dir, "package.json");
      return { dir, path, manifest: JSON.parse(readFileSync(path, "utf8")) };
    });
}

/**
 * Everything that breaks the one-version rule for `version`: a package with another version,
 * or a dependency on a workspace package that is not exactly `version`.
 * @param {{ dir: string, manifest: Record<string, any> }[]} manifests
 * @param {string} version
 * @returns {string[]}
 */
export function versionProblems(manifests, version) {
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  const problems = [];
  for (const { dir, manifest } of manifests) {
    if (manifest.version !== version) {
      problems.push(`packages/${dir}: version is ${manifest.version}, expected ${version}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (names.has(name) && range !== version) {
          problems.push(`packages/${dir}: ${field}.${name} is ${range}, expected ${version}`);
        }
      }
    }
  }
  return problems;
}

/**
 * The shared version, or null when the packages disagree.
 * @param {{ manifest: Record<string, any> }[]} manifests
 * @returns {string | null}
 */
export function sharedVersion(manifests) {
  const versions = new Set(manifests.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) return null;
  const [version] = versions;
  return versionProblems(/** @type {any} */ (manifests), version).length === 0 ? version : null;
}

/**
 * New manifests with `version` set, and every dependency on a workspace package set to it.
 * Key order is kept. The input is not changed.
 * @template {{ manifest: Record<string, any> }} T
 * @param {T[]} manifests
 * @param {string} version
 * @returns {T[]}
 */
export function bumpManifests(manifests, version) {
  if (!isValidVersion(version)) throw new Error("not a valid semantic version");
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  return manifests.map((entry) => {
    const manifest = structuredClone(entry.manifest);
    manifest.version = version;
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (names.has(name)) manifest[field][name] = version;
      }
    }
    return { ...entry, manifest };
  });
}

/**
 * Run one command of this script against a root. Returns the exit code and the lines to print.
 * @param {string[]} args
 * @param {string} root
 * @returns {{ code: number, out: string[], err: string[] }}
 */
export function run(args, root = REPO_ROOT) {
  const [command, version] = args;
  const manifests = readManifests(root);
  if (command === "current" && args.length === 1) {
    const shared = sharedVersion(manifests);
    if (shared === null) {
      const lines = manifests.map(({ dir, manifest }) => `packages/${dir}: ${manifest.version}`);
      return {
        code: 1,
        out: [],
        err: ["version: the packages do not share one version", ...lines],
      };
    }
    return { code: 0, out: [shared], err: [] };
  }
  if ((command === "check" || command === "bump") && args.length === 2) {
    // The version is printed only once it is known to be a plain semantic version.
    if (!isValidVersion(version)) {
      return {
        code: 1,
        out: [],
        err: ["version: not a valid semantic version (for example 0.1.0)"],
      };
    }
    if (command === "check") {
      const problems = versionProblems(manifests, version);
      if (problems.length > 0) return { code: 1, out: [], err: problems };
      return { code: 0, out: [`version: every package is at ${version}`], err: [] };
    }
    const bumped = bumpManifests(manifests, version);
    for (const { path, manifest } of bumped) {
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return {
      code: 0,
      out: [
        `version: set ${version} in ${bumped.length} package(s)`,
        "next: npm install --package-lock-only --ignore-scripts",
      ],
      err: [],
    };
  }
  return {
    code: 2,
    out: [],
    err: ["usage: node scripts/release/version.mjs current | check <version> | bump <version>"],
  };
}

function main() {
  try {
    const { code, out, err } = run(process.argv.slice(2));
    for (const line of out) console.log(line);
    for (const line of err) console.error(line);
    process.exitCode = code;
  } catch (error) {
    console.error(`version: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
