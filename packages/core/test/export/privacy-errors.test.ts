/**
 * Ticket #23: what the export path says when it refuses something. Error text is the channel
 * people paste into issues, so no message may quote a value from the rejected input. A marker
 * is planted at every leaf and as property names of a replay value, and every problem line,
 * error message and thrown error is searched for it.
 */
import { describe, expect, it } from "vitest";
import {
  assertReplay,
  describeReplayProblems,
  exportReplay,
  MAX_REPORTED_PROBLEMS,
  ReplayValidationError,
  validateReplay,
  type ExportOptions,
  type ReplayModel,
} from "../../src/index.js";
import { ALL_MARKERS, FREE_TEXT_MARKERS, hasMarker, IDENTIFIER_MARKERS } from "./audit-markers.js";
import { makeModel } from "./model.js";

type Path = (string | number)[];

/** Paths of every leaf (string, number, boolean, null) of a value. */
function leaves(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown, i) => leaves(item, [...path, i]));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]));
  }
  return [path];
}

/** Paths of every object (not array) of a value, the root included. */
function objects(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown, i) => objects(item, [...path, i]));
  if (typeof value === "object" && value !== null) {
    return [path, ...Object.entries(value).flatMap(([key, item]) => objects(item, [...path, key]))];
  }
  return [];
}

function at(root: unknown, path: Path): Record<string | number, unknown> {
  let node = root as Record<string | number, unknown>;
  for (const step of path) node = node[step] as Record<string | number, unknown>;
  return node;
}

function setLeaf(root: unknown, path: Path, value: unknown): void {
  at(root, path.slice(0, -1))[path[path.length - 1] as string | number] = value;
}

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "";
}

describe("validation messages never quote a value", () => {
  it("names a pointer and a rule, never the planted value, for every leaf of a replay", () => {
    const failures: string[] = [];
    let rejected = 0;
    for (const [index, path] of leaves(makeModel()).entries()) {
      for (const marker of [
        FREE_TEXT_MARKERS[index % FREE_TEXT_MARKERS.length] as string,
        IDENTIFIER_MARKERS[index % IDENTIFIER_MARKERS.length] as string,
      ]) {
        const value = structuredClone(makeModel()) as unknown;
        setLeaf(value, path, marker);
        const problems = describeReplayProblems(value);
        if (problems.length > 0) rejected += 1;
        const texts = [
          ...problems,
          messageOf(() => assertReplay(value)),
          messageOf(() => exportReplay(value as ReplayModel)),
        ];
        if (texts.some(hasMarker)) failures.push(`/${path.join("/")}`);
      }
    }
    expect(failures).toEqual([]);
    expect(rejected).toBeGreaterThan(100);
  });

  it("hides a free-text property name and shows only identifier-shaped ones (finding F7)", () => {
    for (const path of objects(makeModel())) {
      for (const marker of FREE_TEXT_MARKERS) {
        const value = structuredClone(makeModel()) as unknown;
        at(value, path)[marker] = marker;
        const problems = describeReplayProblems(value);
        expect(problems.join("\n")).toContain("(name not shown)");
        expect(problems.some(hasMarker)).toBe(false);
        // Export builds from the allow-list, so the extra property is dropped, not reported.
        expect(hasMarker(exportReplay(value as ReplayModel).data)).toBe(false);
      }
    }
    // Accepted: a property name shaped like an identifier (up to 32 characters) is named, so a
    // person can see which property is extra. Only validation of a file someone already holds
    // reaches this; export never does.
    const value = structuredClone(makeModel()) as unknown as Record<string, unknown>;
    value["zqxtoken0fake0secret0value"] = 1;
    expect(describeReplayProblems(value).some(hasMarker)).toBe(true);
    expect(hasMarker(exportReplay(value as unknown as ReplayModel).data)).toBe(false);
  });

  it("does not descend into a property the format does not list", () => {
    const value = structuredClone(makeModel()) as unknown as Record<string, unknown>;
    value["extra"] = { [FREE_TEXT_MARKERS[0] as string]: { deeper: FREE_TEXT_MARKERS[1] } };
    const problems = describeReplayProblems(value);
    expect(problems).toEqual(['(root): has a property the format does not allow: "extra"']);
  });

  it("caps the list of problems, so the count is all a long file reveals", () => {
    const value = structuredClone(makeModel()) as unknown;
    for (const path of leaves(value)) setLeaf(value, path, FREE_TEXT_MARKERS[0]);
    const problems = describeReplayProblems(value);
    expect(problems.length).toBe(MAX_REPORTED_PROBLEMS + 1);
    expect(problems[problems.length - 1]).toMatch(/^\.\.\. and \d+ more$/);
    expect(problems.some(hasMarker)).toBe(false);
    expect(validateReplay(value)).toBe(false);
  });
});

describe("exportReplay options never echo a value", () => {
  it("rejects an unknown format or a non-boolean pretty without quoting it", () => {
    for (const marker of ALL_MARKERS) {
      const format = messageOf(() =>
        exportReplay(makeModel(), { format: marker } as unknown as ExportOptions),
      );
      const pretty = messageOf(() =>
        exportReplay(makeModel(), { pretty: marker } as unknown as ExportOptions),
      );
      expect(format).toMatch(/^TypeError: /);
      expect(pretty).toMatch(/^TypeError: /);
      expect(hasMarker(format) || hasMarker(pretty)).toBe(false);
    }
  });

  it("never names the session in the file name", () => {
    const value = structuredClone(makeModel()) as unknown as Record<string, unknown>;
    for (const marker of ALL_MARKERS) value[marker] = marker;
    expect(exportReplay(value as unknown as ReplayModel).fileName).toBe("orbitrace.replay.json");
  });

  it("throws a ReplayValidationError, not a raw schema error, for a name that is free text", () => {
    const value = structuredClone(makeModel()) as unknown;
    setLeaf(value, ["agents", 1, "name"], FREE_TEXT_MARKERS[0]);
    let caught: unknown;
    try {
      exportReplay(value as ReplayModel);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReplayValidationError);
    expect((caught as ReplayValidationError).problems).toEqual([
      '/agents/1/name: must match pattern "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"',
    ]);
  });
});
