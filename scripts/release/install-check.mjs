#!/usr/bin/env node
// Installs the CLI tarball ALONE into an empty temporary project and runs the installed command
// against a synthetic Claude Code config folder (#120):
//
//   node scripts/release/install-check.mjs                      pack packages/cli, then check it
//   node scripts/release/install-check.mjs --tarball <file>     check an existing tarball
//   node scripts/release/install-check.mjs ... --json           the result as JSON
//
// Run `npm run build` at the repository root first. pack-release.mjs runs this script on the
// CLI tarball it writes, so the release workflow checks the artefact it uploads.
//
// What it checks, in order:
//   1. `npm install --offline <tarball>` in an empty project succeeds, with no other tarball and
//      no registry: the CLI must need nothing that is not inside it;
//   2. node_modules then holds the CLI and nothing else;
//   3. through the installed bin link: `orbitrace --version`, `--help`, `list --json`,
//      `export --latest -o <file>` (a valid replay) and `open --no-browser --json` (the server
//      serves the bundled web app, and stops with exit code 0 on SIGINT).
//
// Privacy: HOME, USERPROFILE, APPDATA, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR and npm's cache and
// user config all point into the temporary folder before the first command runs, so neither
// the real Claude Code config folder nor the real npm cache is ever read. The config folder
// holds only sessions from the seeded generator in @orbitrace/fixtures. Findings name the step
// and the problem; output of the command is never printed, and the temporary folder is
// replaced by "<work>" in anything reported. The folder is deleted afterwards.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReplay } from "@orbitrace/core";
import { CONFIG_FOLDER, SCENARIO_NAMES, writeFixtureTree } from "@orbitrace/fixtures";
import { NPM_PACKAGES, REPO_ROOT, packNpm } from "./lib.mjs";

export const USAGE = "usage: node scripts/release/install-check.mjs [--tarball <file>] [--json]";

/** How long one command may run before it is killed. */
export const STEP_TIMEOUT_MS = 60_000;

/** The CLI's name on the command line and in node_modules. */
export const CLI_PACKAGE = "orbitrace";

/**
 * Parse the arguments (without node and the script path).
 * @param {string[]} args
 * @returns {{ tarball: string | null, json: boolean }}
 */
export function parseArgs(args) {
  const options = { tarball: /** @type {string | null} */ (null), json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--tarball") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`--tarball needs a value\n${USAGE}`);
      options.tarball = next;
      i += 1;
    } else throw new Error(`unknown argument\n${USAGE}`);
  }
  return options;
}

/**
 * The folders of one check, all inside `work`.
 * @param {string} work
 */
export function workLayout(work) {
  return {
    work,
    home: join(work, "home"),
    fixtures: join(work, "fixtures"),
    config: join(work, "fixtures", CONFIG_FOLDER),
    project: join(work, "project"),
    npmCache: join(work, "npm-cache"),
    out: join(work, "out"),
  };
}

/**
 * The environment of every command the check runs: the home folder, the Claude Code config
 * folder and npm's cache and user config all inside the work folder. Only PATH (and SystemRoot
 * on Windows) come from this process.
 * @param {ReturnType<typeof workLayout>} layout
 * @param {NodeJS.ProcessEnv} [from] the environment to take PATH from
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedEnv(layout, from = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    HOME: layout.home,
    USERPROFILE: layout.home,
    APPDATA: join(layout.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(layout.home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(layout.home, ".config"),
    CLAUDE_CONFIG_DIR: layout.config,
    TZ: "UTC",
    npm_config_cache: layout.npmCache,
    npm_config_userconfig: join(layout.home, ".npmrc"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  if (from.PATH !== undefined) env.PATH = from.PATH;
  if (from.Path !== undefined && env.PATH === undefined) env.PATH = from.Path;
  if (from.SystemRoot !== undefined) env.SystemRoot = from.SystemRoot;
  return env;
}

/**
 * Replace the work folder in a text with "<work>", so a finding never names a folder of the
 * machine that ran the check.
 * @param {string} text
 * @param {string} work
 */
export function scrub(text, work) {
  return work.length > 0 ? text.split(work).join("<work>") : text;
}

/**
 * The entries of node_modules that are not the CLI or npm's own files: what npm pulled in
 * besides the tarball.
 * @param {string[]} entries names in node_modules
 * @returns {string[]}
 */
export function extraModules(entries) {
  return entries
    .filter((name) => name !== CLI_PACKAGE && name !== ".bin" && name !== ".package-lock.json")
    .sort();
}

/**
 * The command and leading arguments that run the installed CLI: the npm bin link on POSIX, so
 * the shebang and the executable bit are tested; Node with the bin target on Windows, where the
 * link is a .cmd file.
 * @param {string} project
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, args: string[] }}
 */
export function installedCommand(project, platform = process.platform) {
  if (platform === "win32") {
    return {
      command: process.execPath,
      args: [join(project, "node_modules", CLI_PACKAGE, "dist", "index.js")],
    };
  }
  return { command: join(project, "node_modules", ".bin", CLI_PACKAGE), args: [] };
}

/**
 * Check the result of one finished command and return its problems.
 * @param {string} step
 * @param {{ status: number | null, error?: Error, signal?: string | null }} result
 * @returns {string[]}
 */
export function exitProblems(step, result) {
  if (result.error) return [`${step}: could not run (${result.error.name})`];
  if (result.status !== 0) {
    return [`${step}: exited with ${result.status ?? `signal ${result.signal ?? "unknown"}`}`];
  }
  return [];
}

/**
 * Check the stdout of `list --json`: one document with `expected` sessions and no warnings.
 * @param {string} stdout
 * @param {number} expected
 * @returns {string[]}
 */
export function listProblems(stdout, expected) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return ["list --json: stdout is not one JSON document"];
  }
  const problems = [];
  const sessions = Array.isArray(doc?.sessions) ? doc.sessions : null;
  if (sessions === null) return ["list --json: no sessions array"];
  if (sessions.length !== expected) {
    problems.push(
      `list --json: ${sessions.length} session(s), expected the ${expected} synthetic ones only`,
    );
  }
  if (!sessions.every((s) => typeof s?.key === "string" && s.key.startsWith("claude-code:"))) {
    problems.push("list --json: a session has no claude-code key");
  }
  if (!Array.isArray(doc.warnings) || doc.warnings.length > 0) {
    problems.push("list --json: warnings were reported");
  }
  return problems;
}

/**
 * Check the replay file `export` wrote.
 * @param {string} file
 * @returns {string[]}
 */
export function replayProblems(file) {
  if (!existsSync(file)) return ["export: wrote no file"];
  try {
    return validateReplay(JSON.parse(readFileSync(file, "utf8")))
      ? []
      : ["export: the file is not a valid replay"];
  } catch {
    return ["export: the file is not JSON"];
  }
}

/**
 * GET `/` from the loopback server.
 * @param {number} port
 * @returns {Promise<{ status: number, body: string }>}
 */
export function fetchIndex(port) {
  return new Promise((resolvePage, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", headers: { host: `127.0.0.1:${port}` }, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolvePage({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(STEP_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Run `open --no-browser --json`, read the link, load the web app from the server, then stop
 * the command with SIGINT (as Ctrl+C does) and check that it exits with 0.
 * @param {{ command: string, args: string[] }} cli
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<string[]>}
 */
export function checkOpen(cli, options) {
  return new Promise((resolveProblems) => {
    const problems = [];
    const child = spawn(cli.command, [...cli.args, "open", "--no-browser", "--json"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let started = false;
    const timer = setTimeout(() => {
      problems.push("open: timed out");
      child.kill("SIGKILL");
    }, STEP_TIMEOUT_MS);
    child.on("error", (error) => problems.push(`open: could not run (${error.name})`));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", async (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (started || newline === -1) return;
      started = true;
      try {
        const doc = JSON.parse(stdout.slice(0, newline));
        if (doc.browser !== "skipped") problems.push("open: the browser was not skipped");
        if (typeof doc.key !== "string" || !doc.key.startsWith("claude-code:")) {
          problems.push("open: no session was chosen");
        }
        const page = await fetchIndex(doc.port);
        if (page.status !== 200 || !page.body.includes("<title>Orbitrace</title>")) {
          problems.push(`open: the web app was not served (HTTP ${page.status})`);
        }
      } catch (error) {
        problems.push(
          `open: ${error instanceof SyntaxError ? "the first line is not JSON" : "could not load the web app"}`,
        );
      }
      // Windows cannot send SIGINT to a child; there the exit code is not checked.
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGINT");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!started && !problems.some((p) => p.startsWith("open:"))) {
        problems.push(`open: exited before printing the link (${code ?? signal})`);
      } else if (started && process.platform !== "win32" && code !== 0) {
        problems.push(`open: exited with ${code ?? `signal ${signal}`} after SIGINT`);
      }
      resolveProblems(problems);
    });
  });
}

/**
 * Install `tarball` alone into an empty project inside `work` and run the installed command.
 * @param {string} tarball an npm tarball of the CLI
 * @param {{ work: string, version: string, npm?: string }} options `work` must be an empty folder
 * @returns {Promise<{ steps: { name: string, ok: boolean }[], errors: string[] }>}
 */
export async function installCheck(tarball, options) {
  const layout = workLayout(options.work);
  for (const dir of [layout.home, layout.project, layout.npmCache, layout.out]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFixtureTree(layout.fixtures);
  const env = isolatedEnv(layout);
  const steps = [];
  const errors = [];
  const record = (name, problems) => {
    steps.push({ name, ok: problems.length === 0 });
    errors.push(...problems.map((problem) => scrub(problem, layout.work)));
    return problems.length === 0;
  };

  writeFileSync(
    join(layout.project, "package.json"),
    `${JSON.stringify({ name: "install-check", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  const npm = options.npm ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const install = spawnSync(npm, ["install", "--offline", "--no-audit", "--no-fund", tarball], {
    cwd: layout.project,
    env,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS * 3,
    shell: process.platform === "win32",
  });
  if (!record("npm install <tarball> (alone, offline)", exitProblems("npm install", install))) {
    return { steps, errors };
  }
  const modules = join(layout.project, "node_modules");
  const extra = extraModules(readdirSync(modules));
  record(
    "node_modules holds the CLI only",
    extra.length > 0 ? [`npm install: also installed ${extra.length} other package(s)`] : [],
  );

  const cli = installedCommand(layout.project);
  /** @param {string[]} args */
  const run = (args) =>
    spawnSync(cli.command, [...cli.args, ...args], {
      cwd: layout.home,
      env,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
    });

  const version = run(["--version"]);
  record("orbitrace --version", [
    ...exitProblems("--version", version),
    ...(version.status === 0 && !version.stdout.startsWith(`orbitrace ${options.version} `)
      ? [`--version: does not print orbitrace ${options.version}`]
      : []),
  ]);

  const help = run(["--help"]);
  record("orbitrace --help", [
    ...exitProblems("--help", help),
    ...(help.status === 0 && !/\blist\b[\s\S]*\bexport\b[\s\S]*\bopen\b/.test(help.stdout)
      ? ["--help: does not list the commands"]
      : []),
  ]);

  const list = run(["list", "--json"]);
  record("orbitrace list --json", [
    ...exitProblems("list --json", list),
    ...(list.status === 0 ? listProblems(list.stdout, SCENARIO_NAMES.length) : []),
  ]);

  const replayFile = join(layout.out, "replay.json");
  const exported = run(["export", "--latest", "-o", replayFile]);
  record("orbitrace export --latest -o <file>", [
    ...exitProblems("export", exported),
    ...(exported.status === 0 ? replayProblems(replayFile) : []),
  ]);

  record("orbitrace open --no-browser", await checkOpen(cli, { cwd: layout.home, env }));
  return { steps, errors };
}

/**
 * Pack packages/cli (or take `tarball`), then run installCheck in a new temporary folder that
 * is deleted afterwards.
 * @param {{ tarball?: string | null, root?: string }} [options]
 */
export async function runInstallCheck(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const spec = NPM_PACKAGES.find((entry) => entry.name === CLI_PACKAGE);
  if (!spec) throw new Error("the CLI is not in NPM_PACKAGES");
  const work = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-install-")));
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", spec.dir, "package.json"), "utf8"),
    );
    let tarball = options.tarball ? resolve(options.tarball) : null;
    if (tarball === null) {
      const packDir = join(work, "pack");
      mkdirSync(packDir);
      tarball = packNpm(join(root, "packages", spec.dir), packDir).path;
    }
    const checkDir = join(work, "check");
    mkdirSync(checkDir);
    return await installCheck(tarball, { work: checkDir, version: manifest.version });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runInstallCheck({ tarball: options.tarball });
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      for (const step of result.steps) {
        process.stdout.write(`  ${step.ok ? "ok    " : "FAILED"} ${step.name}\n`);
      }
      for (const error of result.errors) process.stdout.write(`  error: ${error}\n`);
      process.stdout.write(
        result.errors.length === 0
          ? `install-check: the CLI tarball installs alone and runs (${result.steps.length} steps)\n`
          : `install-check: ${result.errors.length} error(s)\n`,
      );
    }
    if (result.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`install-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) await main();
