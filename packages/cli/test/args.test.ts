import { describe, expect, it } from "vitest";
import {
  COMMAND_NAMES,
  COMMANDS,
  DOCTOR_DEFAULT_PARSE_LIMIT,
  defaultOpenCommand,
  isCommandName,
  parseCommandLine,
  parseLimit,
  parsePort,
  parseRoundTimes,
  wantsJson,
} from "../src/args.js";
import { CliError } from "../src/errors.js";

/** The error `parseCommandLine` throws for `argv`, or undefined when it does not throw. */
function thrownBy(argv: string[]): unknown {
  try {
    parseCommandLine(argv);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The message of the usage error `parseCommandLine` throws for `argv`. */
function usageMessage(argv: string[]): string {
  const error = thrownBy(argv);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("usage");
  expect((error as CliError).hint).toMatch(/--help/);
  return (error as CliError).message;
}

describe("parseCommandLine", () => {
  it("shows the main help with --help, and the version with --version", () => {
    expect(parseCommandLine(["--help"])).toEqual({ kind: "help", json: false });
    expect(parseCommandLine(["-h", "--json"])).toEqual({ kind: "help", json: true });
    expect(parseCommandLine(["--version"])).toEqual({ kind: "version", json: false });
    expect(parseCommandLine(["--json", "-V"])).toEqual({ kind: "version", json: true });
    expect(parseCommandLine(["--help", "--version"])).toEqual({ kind: "help", json: false });
  });

  it("parses list with its options, before or after --json", () => {
    expect(parseCommandLine(["list"])).toEqual({
      kind: "list",
      json: false,
      sources: { configDirs: [], extraRoots: false },
    });
    expect(
      parseCommandLine([
        "--json",
        "list",
        "--config-dir",
        "one",
        "--config-dir=two",
        "--extra-roots",
        "--limit",
        "5",
      ]),
    ).toEqual({
      kind: "list",
      json: true,
      sources: { configDirs: ["one", "two"], extraRoots: true },
      limit: 5,
    });
    expect(parseCommandLine(["list", "--json"])).toMatchObject({ kind: "list", json: true });
  });

  it("parses export with a key or --latest", () => {
    expect(parseCommandLine(["export", "claude-code:abcd"])).toEqual({
      kind: "export",
      json: false,
      sources: { configDirs: [], extraRoots: false },
      key: "claude-code:abcd",
      latest: false,
      force: false,
      pretty: false,
      exportOptions: { names: "as-written", roundTimes: null, bucketTokens: false },
    });
    expect(
      parseCommandLine(["export", "--latest", "-o", "out.json", "--force", "--pretty", "--json"]),
    ).toEqual({
      kind: "export",
      json: true,
      sources: { configDirs: [], extraRoots: false },
      latest: true,
      output: "out.json",
      force: true,
      pretty: true,
      exportOptions: { names: "as-written", roundTimes: null, bucketTokens: false },
    });
    expect(parseCommandLine(["export", "--latest", "--output=-"])).toMatchObject({ output: "-" });
    expect(parseCommandLine(["export", "--latest", "-o", "-"])).toMatchObject({ output: "-" });
  });

  it("parses the opt-in export options (#122, #123)", () => {
    expect(
      parseCommandLine([
        "export",
        "--latest",
        "--opaque-names",
        "--round-times",
        "0.1",
        "--bucket-tokens",
      ]),
    ).toMatchObject({
      kind: "export",
      exportOptions: { names: "opaque", roundTimes: 0.1, bucketTokens: true },
    });
    expect(parseCommandLine(["export", "--latest", "--round-times=5"])).toMatchObject({
      exportOptions: { names: "as-written", roundTimes: 5, bucketTokens: false },
    });
    expect(usageMessage(["export", "--latest", "--round-times", "0"])).toContain("--round-times");
    expect(usageMessage(["export", "--latest", "--round-times"])).toContain("--round-times");
    expect(usageMessage(["export", "--latest", "--opaque-names=yes"])).toContain("--opaque-names");
    expect(usageMessage(["export", "--latest", "--keep-names"])).toContain("--keep-names");
    expect(usageMessage(["list", "--opaque-names"])).toContain("--opaque-names");
  });

  it("turns --help after a command, and help <command>, into that command's help", () => {
    for (const name of COMMAND_NAMES) {
      expect(parseCommandLine([name, "--help"])).toEqual({
        kind: "help",
        json: false,
        command: name,
      });
      expect(parseCommandLine([name, "-h", "--json"])).toEqual({
        kind: "help",
        json: true,
        command: name,
      });
      expect(parseCommandLine(["help", name])).toEqual({
        kind: "help",
        json: false,
        command: name,
      });
    }
    expect(parseCommandLine(["help"])).toEqual({ kind: "help", json: false });
    expect(parseCommandLine(["--help", "export"])).toEqual({
      kind: "help",
      json: false,
      command: "export",
    });
  });

  it("accepts '--' before the command", () => {
    expect(parseCommandLine(["--", "list"])).toMatchObject({ kind: "list" });
  });

  it("rejects what it does not understand with a usage error", () => {
    expect(usageMessage(["bogus"])).toContain("Unknown command 'bogus'");
    expect(usageMessage(["--bogus"])).toContain("Unknown option '--bogus'");
    expect(usageMessage(["list", "--bogus"])).toContain("--bogus");
    expect(usageMessage(["list", "x"])).toContain("takes no arguments");
    expect(usageMessage(["list", "--config-dir", ""])).toContain("--config-dir");
    expect(usageMessage(["list", "--limit", "-1"])).toMatch(/limit|-1/);
    expect(usageMessage(["export"])).toContain("session key or --latest");
    expect(usageMessage(["export", "k", "--latest"])).toContain("not both");
    expect(usageMessage(["export", "k1", "k2"])).toContain("one session key");
    expect(usageMessage(["export", " "])).toContain("empty");
    expect(usageMessage(["export", "--latest", "-o", " "])).toContain("-o");
    expect(usageMessage(["export", "--latest", "--pretty=yes"])).toContain("--pretty");
    expect(usageMessage(["help", "a", "b"])).toContain("at most one");
    expect(usageMessage(["help", "bogus"])).toContain("Unknown command 'bogus'");
    expect(usageMessage(["-V", "list"])).toContain("--version");
  });

  it("points a command's usage error at that command's help", () => {
    expect((thrownBy(["export"]) as CliError).hint).toContain("orbitrace export --help");
    expect((thrownBy(["bogus"]) as CliError).hint).toContain("orbitrace --help");
  });
});

describe("parseLimit", () => {
  it("accepts whole numbers of at least 1", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit(" 25 ")).toBe(25);
  });

  it("rejects anything else", () => {
    for (const value of ["0", "-3", "1.5", "ten", "", "99999999999999999999"]) {
      expect(() => parseLimit(value)).toThrow(CliError);
    }
  });

  it("names the flag it was given in the message", () => {
    expect(() => parseLimit("0", "doctor", "--parse-limit")).toThrow(
      "--parse-limit needs a whole number of at least 1.",
    );
    expect(() => parseLimit("x")).toThrow("--limit needs a whole number of at least 1.");
  });
});

describe("parseCommandLine: doctor", () => {
  it("parses doctor with its defaults", () => {
    expect(parseCommandLine(["doctor"])).toEqual({
      kind: "doctor",
      json: false,
      sources: { configDirs: [], extraRoots: false },
      parseLimit: DOCTOR_DEFAULT_PARSE_LIMIT,
    });
    expect(DOCTOR_DEFAULT_PARSE_LIMIT).toBe(20);
  });

  it("parses the source flags, --parse-limit and --json, before or after the command", () => {
    expect(
      parseCommandLine([
        "--json",
        "doctor",
        "--config-dir",
        "./example-config",
        "--extra-roots",
        "--parse-limit",
        "5",
      ]),
    ).toEqual({
      kind: "doctor",
      json: true,
      sources: { configDirs: ["./example-config"], extraRoots: true },
      parseLimit: 5,
    });
    expect(parseCommandLine(["doctor", "--json"])).toMatchObject({ kind: "doctor", json: true });
  });

  it("rejects arguments, a bad --parse-limit and unknown options", () => {
    expect(usageMessage(["doctor", "extra"])).toBe("doctor takes no arguments, got 'extra'.");
    expect(usageMessage(["doctor", "--parse-limit", "0"])).toBe(
      "--parse-limit needs a whole number of at least 1.",
    );
    expect(usageMessage(["doctor", "--fix"])).toMatch(/--fix/);
    expect(usageMessage(["doctor", "--config-dir", " "])).toBe("--config-dir needs a folder path.");
  });

  it("shows the help for doctor", () => {
    expect(parseCommandLine(["doctor", "--help"])).toEqual({
      kind: "help",
      json: false,
      command: "doctor",
    });
  });
});

describe("parseRoundTimes", () => {
  it("accepts 0.001 to 3600 seconds in whole milliseconds", () => {
    expect(parseRoundTimes("0.1")).toBe(0.1);
    expect(parseRoundTimes(" 1 ")).toBe(1);
    expect(parseRoundTimes(".25")).toBe(0.25);
    expect(parseRoundTimes("0.001")).toBe(0.001);
    expect(parseRoundTimes("3600")).toBe(3600);
  });

  it("rejects anything else without repeating the value", () => {
    for (const value of [
      "0",
      "0.0001",
      "3601",
      "-1",
      "1e2",
      "0x10",
      "",
      "ten",
      "1.",
      "1/3",
      "NaN",
    ]) {
      let thrown: unknown;
      try {
        parseRoundTimes(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe("usage");
      expect((thrown as CliError).message).toBe(
        "--round-times needs a number of seconds from 0.001 to 3600, in whole milliseconds, such as 0.1.",
      );
    }
  });
});

describe("wantsJson", () => {
  it("is true when --json comes before any '--'", () => {
    expect(wantsJson(["list", "--json"])).toBe(true);
    expect(wantsJson(["--json"])).toBe(true);
    expect(wantsJson(["list"])).toBe(false);
    expect(wantsJson(["export", "--", "--json"])).toBe(false);
  });
});

describe("isCommandName and COMMANDS", () => {
  it("knows exactly the commands it has specs for", () => {
    expect(COMMAND_NAMES).toEqual(["open", "list", "export", "history", "doctor", "help"]);
    for (const name of COMMAND_NAMES) {
      expect(isCommandName(name)).toBe(true);
      expect(COMMANDS[name].name).toBe(name);
      expect(COMMANDS[name].options.some((option) => option.name === "json")).toBe(true);
      expect(COMMANDS[name].options.some((option) => option.name === "help")).toBe(true);
    }
    expect(isCommandName("bogus")).toBe(false);
  });
});

describe("open on the command line", () => {
  const noSources = { configDirs: [], extraRoots: false };

  it("runs open with its defaults when no command is given", () => {
    expect(parseCommandLine([])).toEqual(defaultOpenCommand(false));
    expect(parseCommandLine(["--json"])).toEqual(defaultOpenCommand(true));
    expect(defaultOpenCommand(false)).toEqual({
      kind: "open",
      json: false,
      sources: noSources,
      latest: false,
      browser: true,
    });
  });

  it("parses a key, --latest, --no-browser, --port and the source flags", () => {
    expect(parseCommandLine(["open"])).toEqual(defaultOpenCommand(false));
    expect(parseCommandLine(["open", "claude-code:abcd"])).toEqual({
      ...defaultOpenCommand(false),
      key: "claude-code:abcd",
    });
    expect(
      parseCommandLine([
        "open",
        "--latest",
        "--no-browser",
        "--port",
        "8123",
        "--config-dir",
        "some/folder",
        "--extra-roots",
        "--json",
      ]),
    ).toEqual({
      kind: "open",
      json: true,
      sources: { configDirs: ["some/folder"], extraRoots: true },
      latest: true,
      browser: false,
      port: 8123,
    });
  });

  it("refuses a key with --latest, two keys, an empty key and a bad port", () => {
    for (const argv of [
      ["open", "abcd", "--latest"],
      ["open", "abcd", "efgh"],
      ["open", " "],
      ["open", "--port", "0"],
      ["open", "--port", "65536"],
      ["open", "--port", "80a"],
      ["open", "--browser"],
    ]) {
      expect(() => parseCommandLine(argv)).toThrow(CliError);
    }
  });
});

describe("parsePort", () => {
  it("takes 1 to 65535 and nothing else", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort(" 65535 ")).toBe(65535);
    for (const bad of ["0", "65536", "-1", "1.5", "", "123456", "0x50"]) {
      expect(() => parsePort(bad)).toThrow(CliError);
    }
  });
});
