/**
 * `orbitrace doctor` as a child process: the built `dist/index.js` in a fresh environment whose
 * HOME and CLAUDE_CONFIG_DIR point at temporary folders (see `runBin` and `fakeEnv`). Nothing
 * from the real environment but PATH reaches the child.
 */
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DoctorReport } from "../src/doctor/report.js";
import { healthyLines, makeHome, writeRegistryEntry, writeSession } from "./doctor-helpers.js";
import { makeFakeMachine, removeTempDirs, runBin } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

function codes(report: DoctorReport): Record<string, string> {
  return Object.fromEntries(report.checks.map((entry) => [entry.id, entry.code]));
}

describe("orbitrace doctor (built binary)", () => {
  it("checks a synthetic config folder named by CLAUDE_CONFIG_DIR, with clean stderr", () => {
    const machine = makeFakeMachine();
    writeRegistryEntry(machine.configDir, "0", { pid: 0, sessionId: "synthetic", status: "idle" });
    const result = runBin(["doctor", "--json", "--parse-limit", "3"], {
      home: machine.home,
      env: { CLAUDE_CONFIG_DIR: machine.configDir },
    });
    // No experimental warning from loading node:sqlite, or anything else, reaches stderr.
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.status).toBe("ok");
    expect(report.node).toBe(process.versions.node);
    expect(codes(report)).toMatchObject({
      "node-version": "node-version-ok",
      "config-folder": "config-folder-ok",
      "session-roots": "session-roots-ok",
      parser: "parser-ok",
      "running-registry": "running-registry-ok",
      "app-bundle": "app-bundle-ok",
      "loopback-port": "loopback-port-ok",
    });
    expect(["history-store-available", "history-store-not-in-use"]).toContain(
      codes(report)["history-store"],
    );
    expect(report.checks.find((entry) => entry.id === "parser")?.details).toMatchObject({
      limit: 3,
      checked: 3,
    });
  });

  it("prints text with a fix for each problem and exits 12 when a check fails", () => {
    const { home } = makeHome();
    const result = runBin(["doctor"], { home, env: { CLAUDE_CONFIG_DIR: join(home, "absent") } });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(12);
    expect(result.stdout).toContain("FAIL  config-folder");
    expect(result.stdout).toContain("[config-folder-missing]");
    expect(result.stdout).toContain("fix: ");
    expect(result.stdout).toContain("Result: fail");
    // The folder named by CLAUDE_CONFIG_DIR is under the home folder, so it is shown with ~.
    expect(result.stdout).not.toContain(home);
  });

  it("shows the default folder under the home folder as ~", () => {
    const { home } = makeHome();
    writeSession(join(home, ".claude"), "example-project", "synthetic-session", healthyLines());
    const result = runBin(["doctor", "--json"], { home });
    const report = JSON.parse(result.stdout) as DoctorReport;
    const folder = report.checks.find((entry) => entry.id === "config-folder");
    expect(folder?.details).toMatchObject({ resolvedBy: "os-default", state: "ok" });
    expect(String(folder?.details.path)).toMatch(/^~[\\/]\.claude$/);
    expect(result.stdout).not.toContain(home);
  });
});
