import { describe, expect, it } from "vitest";
import * as entry from "../src/index";

describe("@orbitrace/app entry", () => {
  it("exports the app, the transports and the start options", () => {
    expect(typeof entry.App).toBe("function");
    expect(typeof entry.createNoHostTransport).toBe("function");
    expect(typeof entry.createDemoTransport).toBe("function");
    expect(typeof entry.parseStartOptions).toBe("function");
    expect(entry.DEMO_SESSION_KEY).toBe("demo");
    expect(entry.DEMO_SESSION.summary.key).toBe("demo");
    expect(entry.OrreryFactoryContext).toBeDefined();
  });
});
