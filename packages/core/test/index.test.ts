import { describe, expect, it } from "vitest";
import { CORE_STATUS } from "../src/index.js";

describe("@orbitrace/core", () => {
  it("exposes the scaffold marker", () => {
    expect(CORE_STATUS).toBe("scaffold");
  });
});
