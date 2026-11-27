// Tests of the shared helpers that have behaviour of their own.

import { describe, expect, it } from "vitest";
import { fakeOrrery, rendererCreated } from "./helpers";

const canvas = () => document.createElement("canvas");

describe("rendererCreated", () => {
  it("resolves with the options of a renderer that already exists", async () => {
    const orrery = fakeOrrery();
    orrery.factory(canvas(), { reducedMotion: true });
    await expect(rendererCreated(orrery)).resolves.toEqual({ reducedMotion: true });
  });

  it("waits for a renderer that is created later, as an effect after a commit is", async () => {
    const orrery = fakeOrrery();
    const waiting = rendererCreated(orrery);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing was created in those 20 ms, so it is still waiting.
    expect(settled).toBe(false);
    orrery.factory(canvas(), { reducedMotion: false });
    await expect(waiting).resolves.toEqual({ reducedMotion: false });
  });

  it("gives the options of the first renderer when the app made a second one", async () => {
    const orrery = fakeOrrery();
    orrery.factory(canvas(), { reducedMotion: false });
    orrery.factory(canvas(), { reducedMotion: true });
    await expect(rendererCreated(orrery)).resolves.toEqual({ reducedMotion: false });
  });

  it("rejects, saying why, when the app never creates a renderer", async () => {
    await expect(rendererCreated(fakeOrrery())).rejects.toThrow(
      "The app has not created its renderer yet.",
    );
  });
});
