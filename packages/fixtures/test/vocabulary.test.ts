import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_MARKER,
  commandText,
  createRng,
  errorText,
  handbackText,
  promptText,
  relativeFilePath,
  replyText,
  resultText,
  searchWord,
  taskDescription,
  thinkingText,
  titleText,
} from "../src/index.js";

const SENTENCES = {
  promptText,
  replyText,
  thinkingText,
  resultText,
  errorText,
  taskDescription,
  handbackText,
  titleText,
};

describe("vocabulary", () => {
  it.each(Object.entries(SENTENCES))("%s starts with the synthetic marker", (_name, make) => {
    const rng = createRng("vocabulary");
    for (let index = 0; index < 40; index += 1) {
      const text = make(rng);
      expect(text.startsWith(`${SYNTHETIC_MARKER} `)).toBe(true);
      expect(text).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it.each(Object.entries({ ...SENTENCES, commandText, searchWord, relativeFilePath }))(
    "%s is the same for the same seed",
    (_name, make) => {
      const first = createRng("same");
      const second = createRng("same");
      const a = Array.from({ length: 10 }, () => make(first));
      const b = Array.from({ length: 10 }, () => make(second));
      expect(a).toEqual(b);
      expect(new Set(a).size).toBeGreaterThan(1);
    },
  );

  it("commandText and searchWord are marked as synthetic", () => {
    const rng = createRng("commands");
    for (let index = 0; index < 40; index += 1) {
      expect(commandText(rng)).toMatch(/^synthetic-[a-z]+ --[a-z]+ [1-9]$/);
      expect(searchWord(rng)).toMatch(/^synthetic_[a-z]+$/);
    }
  });

  it("relativeFilePath stays inside the project folder", () => {
    const rng = createRng("files");
    for (let index = 0; index < 60; index += 1) {
      const path = relativeFilePath(rng);
      expect(path).toMatch(/^(src|test|docs|scripts)\/[a-z]+-[a-z]+\.(ts|test\.ts|md|mjs)$/);
      expect(path.startsWith("/")).toBe(false);
      expect(path).not.toContain("..");
    }
  });
});
