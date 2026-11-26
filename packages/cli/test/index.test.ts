import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_STATUS } from "@orbitrace/core";
import { CLI_NAME, statusLine, versionLine } from "../src/index.js";

describe("orbitrace cli", () => {
  it("prints the name and the version from package.json", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(CLI_NAME).toBe("orbitrace");
    expect(versionLine()).toBe(`orbitrace ${manifest.version}`);
  });

  it("prints the core status imported from @orbitrace/core", () => {
    expect(CORE_STATUS).toBe("scaffold");
    expect(statusLine()).toBe(`${versionLine()} (core: ${CORE_STATUS})`);
  });
});
