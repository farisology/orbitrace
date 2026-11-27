/**
 * Helpers for the `orbitrace doctor` tests: fake hosts and synthetic folders under the system's
 * temporary folder. Every host points HOME (and CLAUDE_CONFIG_DIR when a test sets it) at a
 * temporary folder; the doctor reads its environment from the host only, never from
 * `process.env`, so the real home folder and config folder are never read.
 *
 * All transcript lines are invented.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostContext } from "../src/sessions.js";
import type { DoctorRuntime } from "../src/doctor/run.js";
import { makeTempDir } from "./helpers.js";

/** A posix-style host whose home folder is `home`. `env` is the whole environment. */
export function fakeHost(home: string, env: Record<string, string> = {}): HostContext {
  return { platform: process.platform, homeDir: home, env: { HOME: home, ...env }, cwd: home };
}

/** A new temporary folder with an empty `home` folder in it. */
export function makeHome(): { root: string; home: string } {
  const root = makeTempDir();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home };
}

/** An invented conversation line. */
export function syntheticLine(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    timestamp: "2026-01-15T09:00:00.000Z",
    sessionId: "synthetic-session",
    version: "2.1.300",
    ...extra,
  });
}

/** A user line and an assistant line, both invented. */
export function healthyLines(): string[] {
  return [
    syntheticLine("user", { message: { role: "user", content: "example prompt" } }),
    syntheticLine("assistant", {
      message: {
        id: "msg-example-1",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "example reply" }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    }),
  ];
}

/** Write `<configDir>/projects/<project>/<sessionId>.jsonl`. Returns its path. */
export function writeSession(
  configDir: string,
  project: string,
  sessionId: string,
  lines: readonly string[],
): string {
  const dir = join(configDir, "projects", project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** Write one running-sessions entry, `<configDir>/sessions/<name>.json`. */
export function writeRegistryEntry(
  configDir: string,
  name: string,
  entry: Record<string, unknown>,
): void {
  mkdirSync(join(configDir, "sessions"), { recursive: true });
  writeFileSync(join(configDir, "sessions", `${name}.json`), JSON.stringify(entry));
}

/** A web app folder whose index.html loads two files, both present. */
export function makeAppDir(): string {
  const dir = join(makeTempDir(), "app");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><link rel="icon" href="favicon.svg"><script type="module" src="./assets/index-example.js"></script>',
  );
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  writeFileSync(join(dir, "assets", "index-example.js"), "export {};");
  return dir;
}

/** A runtime with every outside dependency fixed: a supported Node, a complete app, no I/O. */
export function healthyRuntime(appDir: string): DoctorRuntime {
  return {
    nodeVersion: "22.13.0",
    nodeRange: ">=20",
    appDir,
    historyCapability: () =>
      Promise.resolve({
        available: true,
        engine: "node:sqlite",
        nodeVersion: "v22.13.0",
        sqliteVersion: "3.99.0",
        fts5: true,
      }),
    bindLoopback: () => Promise.resolve(),
  };
}

/** True when permission tests cannot work: Windows, or running as root. */
export function cannotTestPermissions(): boolean {
  return process.platform === "win32" || process.getuid?.() === 0;
}
