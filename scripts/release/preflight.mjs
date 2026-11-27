#!/usr/bin/env node
// The first step of the release workflow (.github/workflows/release.yml). It decides whether a
// run may go on, before anything is installed or built:
//
//   VERSION=0.1.0 DRY_RUN=true node scripts/release/preflight.mjs
//
// It reads VERSION and DRY_RUN (the workflow inputs) and GITHUB_REF_TYPE and GITHUB_REF_NAME
// (set by GitHub Actions). DRY_RUN is a dry run unless it is exactly "false", so a missing or
// mistyped value can never turn a run into a real release.
//
// Errors, warnings and notices print as GitHub Actions annotations. The version is printed only
// after it passed the semantic-version check, so an input cannot inject a workflow command.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateChangelog, sectionNotes } from "./changelog.mjs";
import { REPO_ROOT } from "./lib.mjs";
import { isValidVersion, readManifests, versionProblems } from "./version.mjs";

/**
 * Decide whether a release run may continue.
 * @param {{ version: string, dryRun: boolean, refType: string, refName: string, manifests: { dir: string, manifest: Record<string, any> }[], changelog: string }} input
 * @returns {{ errors: string[], warnings: string[], notices: string[] }}
 */
export function preflight(input) {
  const errors = [];
  const warnings = [];
  const notices = [];
  const { version, dryRun, refType, refName, manifests, changelog } = input;

  if (!isValidVersion(version)) {
    errors.push(
      "the version input is not a semantic version without a leading v (for example 0.1.0)",
    );
    return { errors, warnings, notices };
  }
  const tag = `v${version}`;

  errors.push(...versionProblems(manifests, version));
  errors.push(...validateChangelog(changelog).map((problem) => `CHANGELOG.md: ${problem}`));

  if (refType === "tag" && refName !== tag) {
    errors.push(`the run is on a tag that is not ${tag}; run it from ${tag} or from a branch`);
  }

  const vscode = manifests.find(({ dir }) => dir === "vscode")?.manifest;
  const cli = manifests.find(({ dir }) => dir === "cli")?.manifest;
  const noPublisher = !vscode || typeof vscode.publisher !== "string" || vscode.publisher === "";

  if (dryRun) {
    notices.push(`dry run for ${version}: artefacts are built and uploaded; nothing is published`);
    if (refType !== "tag") {
      notices.push(`not run from the ${tag} tag: the artefacts are for testing only`);
    }
    if (noPublisher) {
      warnings.push(
        'packages/vscode/package.json has no "publisher" (#98): VS Code installs the .vsix as "undefined_publisher.orbitrace-vscode"',
      );
    }
    try {
      sectionNotes(changelog, version);
    } catch {
      notices.push(`CHANGELOG.md has no ${version} section yet; a real release needs one`);
    }
  } else {
    if (refType !== "tag" || refName !== tag) {
      errors.push(`a real release must run from the ${tag} tag, not from a branch`);
    }
    if (version === "0.0.0")
      errors.push("0.0.0 is the unreleased placeholder; bump the version first");
    try {
      sectionNotes(changelog, version);
    } catch {
      errors.push(`CHANGELOG.md needs a non-empty ${version} section for a real release`);
    }
    if (noPublisher) {
      errors.push('packages/vscode/package.json needs a "publisher" before a real release (#98)');
    }
    if (cli?.private === true) {
      warnings.push("packages/cli is private, so npm will refuse to publish it (#16)");
    }
    if (version.includes("-")) {
      warnings.push(
        "the VS Code Marketplace does not take a pre-release suffix such as -rc.1; publish the extension from an x.y.z release",
      );
    }
  }
  return { errors, warnings, notices };
}

/**
 * Read the inputs from the environment and the repository.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 */
export function inputFromEnvironment(env, root = REPO_ROOT) {
  return {
    version: env.VERSION ?? "",
    dryRun: env.DRY_RUN !== "false",
    refType: env.GITHUB_REF_TYPE ?? "",
    refName: env.GITHUB_REF_NAME ?? "",
    manifests: readManifests(root),
    changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  };
}

/**
 * The annotation lines for a result. Newlines are escaped so one message stays one command.
 * @param {{ errors: string[], warnings: string[], notices: string[] }} result
 */
export function annotations(result) {
  const escape = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return [
    ...result.notices.map((text) => `::notice title=Release preflight::${escape(text)}`),
    ...result.warnings.map((text) => `::warning title=Release preflight::${escape(text)}`),
    ...result.errors.map((text) => `::error title=Release preflight::${escape(text)}`),
  ];
}

function main() {
  try {
    const result = preflight(inputFromEnvironment(process.env));
    for (const line of annotations(result)) console.log(line);
    if (result.errors.length > 0) {
      console.error(`preflight: ${result.errors.length} error(s); stopping before the build`);
      process.exitCode = 1;
    } else {
      console.log("preflight: ok");
    }
  } catch (error) {
    console.error(`preflight: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
