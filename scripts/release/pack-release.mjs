#!/usr/bin/env node
// Builds the release artefacts into one folder and checks each of them. The release workflow
// runs it after the build and the full checks; you can run it locally the same way:
//
//   node scripts/release/pack-release.mjs --out <folder outside the repository>
//       [--version <v>]          fail unless every package is at <v>
//       [--skip-vsix]            npm tarballs only (no vsce needed)
//       [--require-publisher]    fail when the extension has no publisher (real releases)
//       [--summary <file>]       append a Markdown summary (the workflow passes $GITHUB_STEP_SUMMARY)
//
// Writes into <out>:
//   orbitrace-core-<v>.tgz, orbitrace-renderer-<v>.tgz, orbitrace-<v>.tgz   (npm pack)
//   orbitrace-vscode-<v>.vsix                                               (vsce package)
//   SHA256SUMS            one "<sha256>  <file>" line per artefact (sha256sum -c reads it)
//   release-manifest.json the version, the commit, and each artefact's size, hash and file list
//
// Run `npm run build` first, and `npm ci` in scripts/release/tools for vsce. Nothing is
// published. <out> must be empty or missing, and outside the repository, so artefacts are never
// committed by mistake.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildMachineLiterals,
  checkArtefact,
  formatReport,
  packAndCheck,
  readWorkspaceIndex,
} from "./check-package.mjs";
import {
  NPM_PACKAGES,
  REPO_ROOT,
  TOOLS_DIR,
  VSIX_PACKAGE,
  extractZip,
  formatSize,
  isInside,
  sha256File,
} from "./lib.mjs";
import { isValidVersion, readManifests, versionProblems } from "./version.mjs";

export const USAGE =
  "usage: node scripts/release/pack-release.mjs --out <dir> [--version <v>] [--skip-vsix] [--require-publisher] [--summary <file>]";

/**
 * Parse the arguments (without node and the script path).
 * @param {string[]} args
 * @returns {{ out: string, version: string | null, skipVsix: boolean, requirePublisher: boolean, summary: string | null }}
 */
export function parseArgs(args) {
  const options = {
    out: "",
    version: null,
    skipVsix: false,
    requirePublisher: false,
    summary: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`${arg} needs a value\n${USAGE}`);
      i += 1;
      return next;
    };
    if (arg === "--out") options.out = value();
    else if (arg === "--version") options.version = value();
    else if (arg === "--summary") options.summary = value();
    else if (arg === "--skip-vsix") options.skipVsix = true;
    else if (arg === "--require-publisher") options.requirePublisher = true;
    else throw new Error(`unknown argument\n${USAGE}`);
  }
  if (options.out === "") throw new Error(`--out is required\n${USAGE}`);
  if (options.version !== null && !isValidVersion(options.version)) {
    throw new Error("--version is not a valid semantic version");
  }
  return options;
}

/**
 * Check that the output folder may be used: outside the repository, and empty or missing.
 * @param {string} out
 * @param {string} root
 * @returns {string | null} the problem, or null
 */
export function outputFolderProblem(out, root = REPO_ROOT) {
  if (isInside(root, out))
    return "--out must be outside the repository, so artefacts are never committed";
  if (existsSync(out) && readdirSync(out).length > 0) return "--out must be empty or missing";
  return null;
}

/**
 * The identity line of a .vsix manifest: publisher, id and version.
 * @param {string} xml the extension.vsixmanifest text
 * @returns {{ publisher: string | null, id: string | null, version: string | null }}
 */
export function vsixIdentity(xml) {
  const identity = /<Identity\b[^>]*>/.exec(xml)?.[0] ?? "";
  const attribute = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(identity)?.[1] ?? null;
  return { publisher: attribute("Publisher"), id: attribute("Id"), version: attribute("Version") };
}

/**
 * Package the extension with the pinned vsce, then unpack and check the .vsix.
 * @param {{ root: string, out: string, workDir: string, version: string, requirePublisher: boolean }} options
 */
export function packAndCheckVsix(options) {
  const vsce = join(TOOLS_DIR, "node_modules", ".bin", "vsce");
  if (!existsSync(vsce)) {
    throw new Error(
      "vsce is not installed. Run 'npm ci --ignore-scripts' in scripts/release/tools first, or pass --skip-vsix.",
    );
  }
  const file = `${VSIX_PACKAGE.name}-${options.version}.vsix`;
  const path = join(options.out, file);
  execFileSync(vsce, ["package", "--no-dependencies", "--out", path], {
    cwd: join(options.root, "packages", VSIX_PACKAGE.dir),
    stdio: ["ignore", "ignore", "inherit"],
  });
  const unpacked = extractZip(path, mkdtempSync(join(options.workDir, "vsix-")));
  const { files, errors } = checkArtefact(unpacked, VSIX_PACKAGE, {
    licenseText: readFileSync(join(options.root, "LICENSE"), "utf8"),
    licensePath: "extension/LICENSE.txt",
    literals: buildMachineLiterals(options.root),
  });
  const warnings = [];
  const identity = vsixIdentity(readFileSync(join(unpacked, "extension.vsixmanifest"), "utf8"));
  if (identity.version !== options.version) errors.push("extension.vsixmanifest: version differs");
  if (
    identity.publisher === null ||
    identity.publisher === "" ||
    identity.publisher === "undefined"
  ) {
    const message =
      'extension.vsixmanifest: no publisher (#98); VS Code installs the .vsix as "undefined_publisher.orbitrace-vscode"';
    if (options.requirePublisher) errors.push(message);
    else warnings.push(message);
  }
  return {
    kind: "vsix",
    name: VSIX_PACKAGE.name,
    dir: VSIX_PACKAGE.dir,
    version: options.version,
    private: false,
    file,
    path,
    size: readFileSync(path).length,
    files,
    errors,
    warnings,
  };
}

/**
 * The SHA256SUMS text for a list of artefacts.
 * @param {{ file: string, sha256: string }[]} artefacts
 */
export function checksumsText(artefacts) {
  return artefacts.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join("");
}

/**
 * A Markdown summary for the workflow run page.
 * @param {{ version: string, commit: string | null, artefacts: { name: string, file: string, size: number, sha256: string, files: unknown[], errors: string[], warnings: string[] }[] }} manifest
 */
export function markdownSummary(manifest) {
  const lines = [
    `## Release artefacts ${manifest.version}`,
    "",
    manifest.commit
      ? `Commit \`${manifest.commit}\`. Nothing was published.`
      : "Nothing was published.",
    "",
    "| Artefact | Size | Files | SHA-256 | Check |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const a of manifest.artefacts) {
    const check =
      a.errors.length > 0
        ? `${a.errors.length} error(s)`
        : a.warnings.length > 0
          ? "ok, with warnings"
          : "ok";
    lines.push(
      `| \`${a.file}\` | ${formatSize(a.size)} | ${a.files.length} | \`${a.sha256}\` | ${check} |`,
    );
  }
  const notes = manifest.artefacts.flatMap((a) => [
    ...a.warnings.map((w) => `- ${a.name}: warning: ${w}`),
    ...a.errors.map((e) => `- ${a.name}: error: ${e}`),
  ]);
  if (notes.length > 0) lines.push("", ...notes);
  return `${lines.join("\n")}\n`;
}

/** The current commit, or null outside a git checkout. */
function currentCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Build, check and hash every artefact.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {string} [root]
 */
export function packRelease(options, root = REPO_ROOT) {
  const out = resolve(options.out);
  const problem = outputFolderProblem(out, root);
  if (problem) throw new Error(problem);
  const manifests = readManifests(root);
  const version = options.version ?? manifests.find(({ dir }) => dir === "core")?.manifest.version;
  if (typeof version !== "string") throw new Error("could not read the version of packages/core");
  const problems = versionProblems(manifests, version);
  if (problems.length > 0)
    throw new Error(`packages do not share one version:\n${problems.join("\n")}`);

  mkdirSync(out, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "orbitrace-release-"));
  try {
    const workspaces = readWorkspaceIndex(root);
    const reports = NPM_PACKAGES.map((spec) =>
      packAndCheck(spec, { root, destDir: out, workDir, workspaces }),
    );
    if (!options.skipVsix) {
      reports.push(
        packAndCheckVsix({
          root,
          out,
          workDir,
          version,
          requirePublisher: options.requirePublisher,
        }),
      );
    }
    const artefacts = reports.map(({ path, ...report }) => ({
      ...report,
      sha256: sha256File(path),
    }));
    const manifest = { version, commit: currentCommit(root), artefacts };
    writeFileSync(join(out, "SHA256SUMS"), checksumsText(artefacts));
    writeFileSync(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = packRelease(options);
    process.stdout.write(formatReport(manifest.artefacts));
    process.stdout.write(checksumsText(manifest.artefacts));
    if (options.summary) appendFileSync(options.summary, markdownSummary(manifest));
    const failed = manifest.artefacts.filter((a) => a.errors.length > 0);
    if (failed.length > 0) {
      console.error(`pack-release: ${failed.length} artefact(s) failed their checks`);
      process.exitCode = 1;
    } else {
      console.log(
        `pack-release: ${manifest.artefacts.length} artefact(s) ok in ${resolve(options.out)}`,
      );
    }
  } catch (error) {
    console.error(`pack-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
