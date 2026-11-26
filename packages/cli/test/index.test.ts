import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { CORE_STATUS } from "@orbitrace/core";
import {
  APP_BUNDLE_FOLDER,
  CLI_ERROR_CODES,
  CLI_NAME,
  appBundleDir,
  cliVersion,
  processHost,
  processIo,
  run,
  statusLine,
  versionJson,
  versionLine,
} from "../src/index.js";

describe("orbitrace cli", () => {
  it("prints the name and the version from package.json", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(CLI_NAME).toBe("orbitrace");
    expect(cliVersion()).toBe(manifest.version);
    expect(versionLine()).toBe(`orbitrace ${manifest.version}`);
    expect(versionJson()).toEqual({
      name: "orbitrace",
      version: manifest.version,
      core: CORE_STATUS,
    });
  });

  it("prints the core status imported from @orbitrace/core", () => {
    expect(CORE_STATUS).toBe("ready");
    expect(statusLine()).toBe(`${versionLine()} (core: ${CORE_STATUS})`);
  });

  it("exports the command runner, the app bundle lookup and the error codes", () => {
    expect(typeof run).toBe("function");
    expect(typeof appBundleDir).toBe("function");
    expect(APP_BUNDLE_FOLDER).toBe("app");
    expect(CLI_ERROR_CODES).toContain("usage");
  });

  it("reads the host context from the process", () => {
    expect(processHost()).toEqual({
      platform: process.platform,
      homeDir: homedir(),
      env: process.env,
      cwd: process.cwd(),
    });
  });

  it("writes through the process streams and handles a closed stdout", () => {
    const before = process.stdout.listeners("error");
    const io = processIo();
    const added = process.stdout
      .listeners("error")
      .filter((listener) => !before.includes(listener));
    try {
      expect(added).toHaveLength(1);
      io.stdout("");
      io.stderr("");
    } finally {
      for (const listener of added) {
        process.stdout.removeListener("error", listener as (...args: unknown[]) => void);
      }
    }
  });
});
