import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, COMMANDS } from "../src/args.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import { commandHelpText, helpJson, helpText, mainHelpText } from "../src/help.js";
import { cliVersion } from "../src/version.js";

describe("mainHelpText", () => {
  it("names every command and the global options, and says opening is not available", () => {
    const text = mainHelpText();
    expect(text.startsWith(`orbitrace ${cliVersion()}`)).toBe(true);
    for (const name of COMMAND_NAMES) expect(text).toContain(COMMANDS[name].summary);
    for (const flag of ["--help", "--version", "--json", "-h", "-V"]) expect(text).toContain(flag);
    expect(text).toContain("not affiliated with Anthropic");
    expect(text).toContain("not available yet");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("commandHelpText", () => {
  it("shows the usage and every option of each command", () => {
    for (const name of COMMAND_NAMES) {
      const text = commandHelpText(name);
      expect(text).toContain(COMMANDS[name].usage);
      for (const option of COMMANDS[name].options) expect(text).toContain(`--${option.name}`);
      for (const arg of COMMANDS[name].arguments) expect(text).toContain(`<${arg.name}>`);
    }
    expect(commandHelpText("export")).toContain("--force");
    expect(commandHelpText("export")).toContain("-o, --output <file>");
    expect(commandHelpText("list")).toContain("CLAUDE_CONFIG_DIR");
  });
});

describe("helpText", () => {
  it("is the main help without a command and the command help with one", () => {
    expect(helpText()).toBe(mainHelpText());
    expect(helpText("list")).toBe(commandHelpText("list"));
  });
});

describe("helpJson", () => {
  it("describes every command, or one, with the exit codes", () => {
    const all = helpJson() as { name: string; commands: { name: string }[]; exitCodes: object };
    expect(all.name).toBe("orbitrace");
    expect(all.commands.map((command) => command.name)).toEqual([...COMMAND_NAMES]);
    expect(all.exitCodes).toEqual({ ok: 0, ...CLI_EXIT_CODES });
    const one = helpJson("export") as {
      commands: { name: string; options: { name: string; short?: string }[] }[];
    };
    expect(one.commands).toHaveLength(1);
    expect(one.commands[0]?.options).toContainEqual(
      expect.objectContaining({ name: "--output", short: "-o" }),
    );
    expect(JSON.parse(JSON.stringify(all))).toEqual(all);
  });
});
