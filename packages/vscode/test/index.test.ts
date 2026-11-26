import { describe, expect, it } from "vitest";
import { activate, deactivate } from "../src/index.js";

describe("orbitrace-vscode", () => {
  it("activates and deactivates without doing anything yet", () => {
    expect(() => activate({})).not.toThrow();
    expect(() => deactivate()).not.toThrow();
  });
});
