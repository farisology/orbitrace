import { describe, expect, it } from "vitest";
import { RENDERER_STATUS } from "../src/index.js";

describe("@orbitrace/renderer", () => {
  it("exposes the scaffold marker", () => {
    expect(RENDERER_STATUS).toBe("scaffold");
  });
});
