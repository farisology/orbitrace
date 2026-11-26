#!/usr/bin/env node
// Runs an npm script in every workspace under packages/, in dependency order.
//
// Usage: node scripts/run-workspaces.mjs <script>
//
// npm runs `--workspaces` in folder order, which ignores dependencies. A package that
// imports another workspace resolves it through that workspace's dist/, so the dependency
// must run first. This script reads each packages/*/package.json, sorts the workspaces so
// that every workspace comes after the workspaces it depends on (dependencies and
// devDependencies whose names match a workspace), and runs each one with
// `npm run <script> --workspace <name> --if-present`.
//
// Adding a package needs no edit here or in the root package.json.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Read every packages/<dir>/package.json under root.
 * @param {string} root
 * @returns {{ name: string, dir: string, dependsOn: string[] }[]}
 */
export function readWorkspaces(root) {
  const packagesDir = join(root, "packages");
  const workspaces = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    workspaces.push({
      name: manifest.name,
      dir: join(packagesDir, entry.name),
      dependsOn: [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ],
    });
  }
  return workspaces;
}

/**
 * Sort workspaces so each one comes after the workspaces it depends on. Ties are broken by
 * name, so the order is stable. Throws on a dependency cycle.
 * @param {{ name: string, dependsOn: string[] }[]} workspaces
 * @returns {string[]} workspace names in run order
 */
export function orderWorkspaces(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"

  const visit = (name, trail) => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") {
      throw new Error(`workspace dependency cycle: ${[...trail, name].join(" -> ")}`);
    }
    state.set(name, "visiting");
    const workspace = byName.get(name);
    const internal = workspace.dependsOn.filter((dep) => byName.has(dep)).sort();
    for (const dep of internal) visit(dep, [...trail, name]);
    state.set(name, "done");
    ordered.push(name);
  };

  for (const name of [...byName.keys()].sort()) visit(name, []);
  return ordered;
}

/**
 * Run one npm script in each workspace, in order. Stops at the first failure.
 * @param {string} root
 * @param {string} script
 * @returns {number} exit status
 */
export function runAll(root, script) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const order = orderWorkspaces(readWorkspaces(root));
  for (const name of order) {
    console.log(`\n> ${script}: ${name}`);
    const result = spawnSync(npm, ["run", script, "--workspace", name, "--if-present"], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`${script} failed in ${name}`);
      return result.status ?? 1;
    }
  }
  return 0;
}

function main() {
  const script = process.argv[2];
  if (!script) {
    console.error("usage: node scripts/run-workspaces.mjs <script>");
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = runAll(resolve(process.cwd()), script);
  } catch (error) {
    console.error(`run-workspaces: ${error.message}`);
    process.exitCode = 2;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
