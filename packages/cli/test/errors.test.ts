import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReplayValidationError, SessionReplayError, TRANSPORT_ERROR_CODES } from "@orbitrace/core";
import {
  CLI_ERROR_CODES,
  CLI_EXIT_CODES,
  CliError,
  EXIT_OK,
  INTERNAL_MESSAGE,
  errorToJson,
  errorToText,
  toCliError,
  usageError,
} from "../src/errors.js";

describe("CLI_EXIT_CODES", () => {
  it("gives every code its own exit code, none of them 0", () => {
    const exits = Object.values(CLI_EXIT_CODES);
    expect(new Set(exits).size).toBe(exits.length);
    expect(exits).not.toContain(EXIT_OK);
    expect(CLI_ERROR_CODES).toEqual(Object.keys(CLI_EXIT_CODES));
  });

  it("matches the table in docs/cli.md", () => {
    const doc = readFileSync(new URL("../../../docs/cli.md", import.meta.url), "utf8");
    const rows = [...doc.matchAll(/^\| (\d+) +\| `([a-z-]+)` +\|/gm)].map((match) => [
      match[2],
      Number(match[1]),
    ]);
    expect(Object.fromEntries(rows)).toEqual({ ok: 0, ...CLI_EXIT_CODES });
  });
});

describe("CliError", () => {
  it("carries a code, a hint and the exit code of its code", () => {
    const error = new CliError("output-exists", "The file a.json exists already.", "Use --force.");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("output-exists");
    expect(error.hint).toBe("Use --force.");
    expect(error.exitCode).toBe(8);
    expect(new CliError("internal", "x").hint).toBeUndefined();
  });

  it("usageError points at the help", () => {
    expect(usageError("Bad.").hint).toBe("Run 'orbitrace --help' to see the usage.");
    expect(usageError("Bad.", "list").hint).toBe("Run 'orbitrace list --help' to see the usage.");
    expect(usageError("Bad.").exitCode).toBe(2);
  });
});

describe("toCliError", () => {
  it("keeps a CliError", () => {
    const error = new CliError("ambiguous", "Two.");
    expect(toCliError(error)).toBe(error);
  });

  it("passes core's session codes and messages on", () => {
    for (const code of ["not-found", "unreadable", "invalid", "internal"] as const) {
      const mapped = toCliError(new SessionReplayError(code, `core says ${code}`));
      expect(mapped.code).toBe(code);
      expect(mapped.message).toBe(`core says ${code}`);
    }
    expect(toCliError(new SessionReplayError("not-found", "x")).hint).toContain("orbitrace list");
  });

  it("maps every other core code to internal", () => {
    const mapped = TRANSPORT_ERROR_CODES.filter(
      (code) => !["not-found", "unreadable", "invalid"].includes(code),
    ).map((code) => toCliError(new SessionReplayError(code, "m")).code);
    expect(new Set(mapped)).toEqual(new Set(["internal"]));
  });

  it("turns a failed export check into invalid, with the problem lines", () => {
    const mapped = toCliError(new ReplayValidationError(["/agents/0/name: must match pattern"]));
    expect(mapped.code).toBe("invalid");
    expect(mapped.message).toContain("- /agents/0/name: must match pattern");
  });

  it("never passes on the text of an unknown error", () => {
    const secret = new Error("EACCES: permission denied, open '/private/place/file.jsonl'");
    const mapped = toCliError(secret);
    expect(mapped.code).toBe("internal");
    expect(mapped.message).toBe(INTERNAL_MESSAGE);
    expect(toCliError("a string").message).toBe(INTERNAL_MESSAGE);
  });
});

describe("errorToJson and errorToText", () => {
  it("write the code, exit code, message and hint", () => {
    const error = new CliError("not-found", "No session with that key.", "Run 'orbitrace list'.");
    expect(errorToJson(error)).toEqual({
      error: {
        code: "not-found",
        exitCode: 3,
        message: "No session with that key.",
        hint: "Run 'orbitrace list'.",
      },
    });
    expect(errorToText(error)).toBe(
      "orbitrace: No session with that key. [not-found]\nRun 'orbitrace list'.\n",
    );
  });

  it("leave the hint out when there is none", () => {
    const error = new CliError("internal", "Broke.");
    expect(errorToJson(error).error).not.toHaveProperty("hint");
    expect(errorToText(error)).toBe("orbitrace: Broke. [internal]\n");
  });
});
