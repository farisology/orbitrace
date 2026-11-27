// Tests for scripts/release/install-check.mjs. Synthetic data only: the config folder comes from
// the seeded generator, the fake commands below are invented, and every folder is temporary.
// The last block installs the real CLI tarball alone (after `npm run build`); it takes a few
// seconds and runs in `npm test`, so CI runs it on every pull request.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goldenReplayPath } from "@orbitrace/fixtures";
import {
  CLI_PACKAGE,
  USAGE,
  checkOpen,
  exitProblems,
  extraModules,
  fetchIndex,
  installCheck,
  installedCommand,
  isolatedEnv,
  listProblems,
  parseArgs,
  replayProblems,
  runInstallCheck,
  scrub,
  workLayout,
} from "./install-check.mjs";
import { REPO_ROOT, packNpm } from "./lib.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbitrace-install-check-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The open and install tests send SIGINT and run npm bin links, which Windows lacks. */
const onWindows = process.platform === "win32";

/** Write a small synthetic command that behaves like `orbitrace open --no-browser --json`. */
function fakeOpenScript(body) {
  const file = join(dir, "fake-open.mjs");
  writeFileSync(file, body);
  return { command: process.execPath, args: [file] };
}

const SERVING_OPEN = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>Orbitrace</title>");
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ url: "http://127.0.0.1:" + port + "/#t=x", port, key: "claude-code:0000", browser: "skipped" }) + "\\n");
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
`;

describe("parseArgs", () => {
  it("takes --tarball and --json", () => {
    expect(parseArgs([])).toEqual({ tarball: null, json: false });
    expect(parseArgs(["--tarball", "a.tgz", "--json"])).toEqual({ tarball: "a.tgz", json: true });
  });

  it("rejects a missing value and unknown arguments", () => {
    expect(() => parseArgs(["--tarball"])).toThrow(/--tarball needs a value/);
    expect(() => parseArgs(["--tarball", "--json"])).toThrow(/--tarball needs a value/);
    expect(() => parseArgs(["--publish"])).toThrow(USAGE);
  });
});

describe("workLayout and isolatedEnv", () => {
  it("keeps every folder inside the work folder", () => {
    const layout = workLayout(join(dir, "w"));
    expect(Object.values(layout).filter((path) => !path.startsWith(join(dir, "w")))).toEqual([]);
    expect(layout.config).toBe(join(dir, "w", "fixtures", "config"));
  });

  it("points home, the config folder and npm into the work folder and copies only PATH", () => {
    const layout = workLayout(join(dir, "w"));
    const env = isolatedEnv(layout, {
      PATH: "/synthetic/bin",
      HOME: "/synthetic/real-home",
      CLAUDE_CONFIG_DIR: "/synthetic/real-config",
      SYNTHETIC_TOKEN: "not-copied",
    });
    expect(env.HOME).toBe(layout.home);
    expect(env.USERPROFILE).toBe(layout.home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(layout.config);
    expect(env.npm_config_cache).toBe(layout.npmCache);
    expect(env.npm_config_userconfig).toBe(join(layout.home, ".npmrc"));
    expect(env.PATH).toBe("/synthetic/bin");
    expect(env).not.toHaveProperty("SYNTHETIC_TOKEN");
    for (const value of Object.values(env)) expect(value).not.toContain("/synthetic/real");
    expect(isolatedEnv(layout, { Path: "C:\\synthetic", SystemRoot: "C:\\sys" })).toMatchObject({
      PATH: "C:\\synthetic",
      SystemRoot: "C:\\sys",
    });
  });
});

describe("small helpers", () => {
  it("scrub replaces the work folder", () => {
    expect(scrub("failed in /w/x/project and /w/x/home", "/w/x")).toBe(
      "failed in <work>/project and <work>/home",
    );
    expect(scrub("unchanged", "")).toBe("unchanged");
  });

  it("extraModules lists what npm installed besides the CLI", () => {
    expect(extraModules([CLI_PACKAGE, ".bin", ".package-lock.json"])).toEqual([]);
    expect(extraModules(["@orbitrace", CLI_PACKAGE, "widget"])).toEqual(["@orbitrace", "widget"]);
  });

  it("installedCommand runs the bin link on POSIX and node with the target on Windows", () => {
    expect(installedCommand("/p", "linux")).toEqual({
      command: join("/p", "node_modules", ".bin", "orbitrace"),
      args: [],
    });
    expect(installedCommand("/p", "win32")).toEqual({
      command: process.execPath,
      args: [join("/p", "node_modules", "orbitrace", "dist", "index.js")],
    });
  });

  it("exitProblems reports a failed start, an exit code and a signal", () => {
    expect(exitProblems("x", { status: 0 })).toEqual([]);
    expect(exitProblems("x", { status: 3 })).toEqual(["x: exited with 3"]);
    expect(exitProblems("x", { status: null, signal: "SIGKILL" })).toEqual([
      "x: exited with signal SIGKILL",
    ]);
    const error = Object.assign(new Error("spawn"), { name: "Error" });
    expect(exitProblems("x", { status: null, error })).toEqual(["x: could not run (Error)"]);
  });

  it("listProblems wants exactly the synthetic sessions and no warnings", () => {
    const session = { key: "claude-code:00000000" };
    const doc = (sessions, warnings = []) => JSON.stringify({ sessions, warnings });
    expect(listProblems(doc([session, session]), 2)).toEqual([]);
    expect(listProblems("not json", 1)).toEqual(["list --json: stdout is not one JSON document"]);
    expect(listProblems("{}", 1)).toEqual(["list --json: no sessions array"]);
    expect(listProblems(doc([session, session, session]), 2)).toEqual([
      "list --json: 3 session(s), expected the 2 synthetic ones only",
    ]);
    expect(listProblems(doc([{ key: 1 }]), 1)).toEqual([
      "list --json: a session has no claude-code key",
    ]);
    expect(listProblems(doc([session], [{ code: "w" }]), 1)).toEqual([
      "list --json: warnings were reported",
    ]);
  });

  it("replayProblems accepts a valid replay and rejects the rest", () => {
    expect(replayProblems(goldenReplayPath("demo"))).toEqual([]);
    expect(replayProblems(join(dir, "missing.json"))).toEqual(["export: wrote no file"]);
    writeFileSync(join(dir, "text.json"), "not json");
    expect(replayProblems(join(dir, "text.json"))).toEqual(["export: the file is not JSON"]);
    writeFileSync(join(dir, "other.json"), JSON.stringify({ formatVersion: 99 }));
    expect(replayProblems(join(dir, "other.json"))).toEqual([
      "export: the file is not a valid replay",
    ]);
  });

  it("fetchIndex reads the page from a local server", async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.headers.host?.startsWith("127.0.0.1:") ? 200 : 403);
      res.end("<title>Orbitrace</title>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    try {
      const page = await fetchIndex(server.address().port);
      expect(page).toEqual({ status: 200, body: "<title>Orbitrace</title>" });
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });
});

describe.skipIf(onWindows)("checkOpen", { timeout: 30_000 }, () => {
  it("passes a command that prints the link, serves the app and exits 0 on SIGINT", async () => {
    const cli = fakeOpenScript(SERVING_OPEN);
    expect(await checkOpen(cli, { cwd: dir, env: process.env })).toEqual([]);
  });

  it("reports a command that exits before printing the link", async () => {
    const cli = fakeOpenScript("process.exit(11);\n");
    expect(await checkOpen(cli, { cwd: dir, env: process.env })).toEqual([
      "open: exited before printing the link (11)",
    ]);
  });

  it("reports a first line that is not JSON and an exit code other than 0", async () => {
    const cli = fakeOpenScript(
      'process.on("SIGINT", () => process.exit(4));\nprocess.stdout.write("not json\\n");\nsetInterval(() => {}, 1000);\n',
    );
    expect(await checkOpen(cli, { cwd: dir, env: process.env })).toEqual([
      "open: the first line is not JSON",
      "open: exited with 4 after SIGINT",
    ]);
  });
});

/** Pack a synthetic package named like the CLI. */
function syntheticTarball(manifest, files) {
  const packageDir = join(dir, "synthetic-package");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: CLI_PACKAGE, version: "0.0.1", license: "MIT", ...manifest }),
  );
  for (const [path, text] of Object.entries(files)) writeFileSync(join(packageDir, path), text);
  const packDir = join(dir, "packed");
  mkdirSync(packDir);
  return packNpm(packageDir, packDir).path;
}

describe.skipIf(onWindows)("installCheck (synthetic tarballs)", { timeout: 120_000 }, () => {
  it("fails when the tarball needs a package that is not installed with it", async () => {
    const tarball = syntheticTarball(
      { dependencies: { "@orbitrace-synthetic/missing-core": "1.0.0" } },
      { "dist/index.js": "#!/usr/bin/env node\n" },
    );
    const result = await runInstallCheck({ tarball });
    expect(result.steps).toEqual([{ name: "npm install <tarball> (alone, offline)", ok: false }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^npm install: exited with \d+$/);
  });

  it("reports every command that does not behave", async () => {
    const tarball = syntheticTarball(
      { bin: { orbitrace: "./dist/index.js" } },
      {
        "dist/index.js": [
          "#!/usr/bin/env node",
          'if (process.argv[2] === "--version") { console.log("orbitrace 9.9.9 (core: synthetic)"); process.exit(0); }',
          "process.exit(2);",
          "",
        ].join("\n"),
      },
    );
    const work = join(dir, "work");
    mkdirSync(work);
    const result = await installCheck(tarball, { work, version: "0.0.1" });
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["npm install <tarball> (alone, offline)", true],
      ["node_modules holds the CLI only", true],
      ["orbitrace --version", false],
      ["orbitrace --help", false],
      ["orbitrace list --json", false],
      ["orbitrace export --latest -o <file>", false],
      ["orbitrace open --no-browser", false],
    ]);
    expect(result.errors).toEqual([
      "--version: does not print orbitrace 0.0.1",
      "--help: exited with 2",
      "list --json: exited with 2",
      "export: exited with 2",
      "open: exited before printing the link (2)",
    ]);
    for (const error of result.errors) expect(error).not.toContain(work);
    // The synthetic config folder was written and the real one was never needed.
    expect(existsSync(join(work, "fixtures", "config"))).toBe(true);
    expect(existsSync(join(work, "home", ".claude"))).toBe(false);
  });
});

const built = existsSync(join(REPO_ROOT, "packages", "cli", "dist", "index.js"));

// `npm test` at the root builds every package first, so this runs in CI.
describe.skipIf(!built)("the real CLI tarball (after npm run build)", () => {
  it(
    "installs alone, offline, and --version, --help, list, export and open all work",
    { timeout: 120_000 },
    async () => {
      const result = await runInstallCheck();
      expect(result.errors).toEqual([]);
      expect(result.steps).toHaveLength(7);
      expect(result.steps.every((step) => step.ok)).toBe(true);
    },
  );
});
