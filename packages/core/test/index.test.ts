import { describe, expect, it } from "vitest";
import { CORE_STATUS } from "../src/index.js";

describe("@orbitrace/core", () => {
  it("reports the core as ready", () => {
    expect(CORE_STATUS).toBe("ready");
  });
});
