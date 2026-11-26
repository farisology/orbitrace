import { describe, expect, it } from "vitest";
import { classifyClaudeCodeTool, TOOL_KINDS } from "../../src/index.js";

describe("classifyClaudeCodeTool", () => {
  it.each([
    ["Bash", "shell"],
    ["Read", "read"],
    ["Grep", "read"],
    ["Glob", "read"],
    ["Edit", "edit"],
    ["Write", "edit"],
    ["Agent", "agent"],
    ["Task", "agent"],
    ["SubagentHandback", "agent"],
    ["ToolSearch", "other"],
    ["WebFetch", "other"],
    ["", "other"],
  ] as const)("maps %j to %s", (name, kind) => {
    expect(classifyClaudeCodeTool(name)).toEqual({ kind, mcpServer: null });
  });

  it("matches built-in names case-sensitively", () => {
    expect(classifyClaudeCodeTool("bash").kind).toBe("other");
    expect(classifyClaudeCodeTool("READ").kind).toBe("other");
  });

  it("does not treat object prototype keys as tool names", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(classifyClaudeCodeTool(name)).toEqual({ kind: "other", mcpServer: null });
    }
  });

  it("classifies mcp__<server>__<tool> as mcp and extracts the server", () => {
    expect(classifyClaudeCodeTool("mcp__demo-server__lookup")).toEqual({
      kind: "mcp",
      mcpServer: "demo-server",
    });
    expect(classifyClaudeCodeTool("mcp__demo_server_two__list_items")).toEqual({
      kind: "mcp",
      mcpServer: "demo_server_two",
    });
    // The server ends at the first double underscore; the rest is the tool name.
    expect(classifyClaudeCodeTool("mcp__demo__tool__with__parts")).toEqual({
      kind: "mcp",
      mcpServer: "demo",
    });
  });

  it("does not treat incomplete mcp names as mcp", () => {
    for (const name of ["mcp__", "mcp__server", "mcp__server__", "mcp____tool", "xmcp__a__b"]) {
      expect(classifyClaudeCodeTool(name)).toEqual({ kind: "other", mcpServer: null });
    }
  });

  it("only returns kinds from TOOL_KINDS", () => {
    for (const name of ["Bash", "Read", "Edit", "Agent", "mcp__a__b", "Other"]) {
      expect(TOOL_KINDS).toContain(classifyClaudeCodeTool(name).kind);
    }
  });
});
