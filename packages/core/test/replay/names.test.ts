import { describe, expect, it } from "vitest";
import {
  agentNameOf,
  assignCallsigns,
  dominant,
  effortOf,
  familyOf,
  modelIdOf,
  toolKindOf,
  toolLabelOf,
} from "../../src/replay/names.js";

describe("agentNameOf", () => {
  it("keeps identifier agent types and replaces the rest whole (no words kept)", () => {
    expect(agentNameOf("code-reviewer")).toBe("code-reviewer");
    expect(agentNameOf("example-plugin:helper")).toBe("example-plugin:helper");
    expect(agentNameOf("x".repeat(64))).toBe("x".repeat(64));
    expect(agentNameOf("two words")).toBe("subagent");
    expect(agentNameOf("--lead")).toBe("subagent");
    expect(agentNameOf("x".repeat(65))).toBe("subagent");
    expect(agentNameOf("src/widget.ts")).toBe("subagent");
    expect(agentNameOf("someone@example.com")).toBe("subagent");
    expect(agentNameOf("line\nbreak")).toBe("subagent");
    expect(agentNameOf("café")).toBe("subagent");
  });

  it("falls back to subagent", () => {
    expect(agentNameOf(null)).toBe("subagent");
    expect(agentNameOf("")).toBe("subagent");
    expect(agentNameOf("!!!")).toBe("subagent");
  });
});

describe("modelIdOf and familyOf", () => {
  it("accepts model ids and rejects the rest", () => {
    expect(modelIdOf("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelIdOf("<synthetic>")).toBeNull();
    expect(modelIdOf("Claude Opus")).toBeNull();
    expect(modelIdOf(null)).toBeNull();
    expect(modelIdOf(undefined)).toBeNull();
  });

  it("derives the word after claude-", () => {
    expect(familyOf("claude-opus-5-5")).toBe("opus");
    expect(familyOf("claude-fable-9-0")).toBe("fable");
    expect(familyOf("claude-3-5-sonnet-20241022")).toBe("sonnet");
    expect(familyOf("claude-newword-1")).toBe("newword");
    expect(familyOf("haiku")).toBe("haiku");
    expect(familyOf("claude-9-9")).toBe("unknown");
    expect(familyOf("other-model-1")).toBe("unknown");
    expect(familyOf(null)).toBe("unknown");
  });
});

describe("effortOf and toolKindOf", () => {
  it("keeps the closed sets", () => {
    expect(effortOf("xhigh")).toBe("xhigh");
    expect(effortOf("turbo")).toBeNull();
    expect(effortOf(null)).toBeNull();
    expect(toolKindOf("shell")).toBe("shell");
    expect(toolKindOf("teleport")).toBe("other");
  });
});

describe("toolLabelOf", () => {
  it("reduces MCP calls to the server", () => {
    expect(toolLabelOf("mcp__docs__search", "mcp", "docs")).toBe("mcp:docs");
    expect(toolLabelOf("mcp__docs__search", "mcp", null)).toBe("mcp:docs");
    expect(toolLabelOf("weird", "mcp", null)).toBe("mcp:unknown");
    expect(toolLabelOf("mcp__example_server-2__c", "mcp", null)).toBe("mcp:example_server-2");
    expect(toolLabelOf("mcp__a b__c", "mcp", null)).toBe("mcp:unknown");
    expect(toolLabelOf("mcp__x__y", "mcp", "a/b")).toBe("mcp:unknown");
    expect(toolLabelOf("mcp__x__y", "mcp", "-lead")).toBe("mcp:unknown");
    expect(toolLabelOf("mcp__x__y", "mcp", "s".repeat(65))).toBe("mcp:unknown");
  });

  it("keeps other names that are identifiers and replaces the rest whole", () => {
    expect(toolLabelOf("Bash", "shell", null)).toBe("Bash");
    expect(toolLabelOf("apply_patch", "edit", null)).toBe("apply_patch");
    expect(toolLabelOf("T".repeat(64), "other", null)).toBe("T".repeat(64));
    expect(toolLabelOf("do it", "other", null)).toBe("unknown");
    expect(toolLabelOf("123", "other", null)).toBe("unknown");
    expect(toolLabelOf("9Read", "other", null)).toBe("unknown");
    expect(toolLabelOf("read-file", "other", null)).toBe("unknown");
    expect(toolLabelOf("T".repeat(65), "other", null)).toBe("unknown");
    expect(toolLabelOf("mcp__x__y", "other", null)).toBe("mcp");
  });
});

describe("dominant", () => {
  it("picks the most frequent value, earliest on a tie", () => {
    expect(dominant(["a", "b", "b", null])).toBe("b");
    expect(dominant(["a", "b", "b", "a"])).toBe("a");
    expect(dominant([null, null])).toBeNull();
    expect(dominant([])).toBeNull();
  });
});

describe("assignCallsigns", () => {
  it("numbers repeated names only", () => {
    expect(assignCallsigns(["main", "x", "y", "x"], ["main"])).toEqual(["main", "x#1", "y", "x#2"]);
  });

  it("keeps fixed callsigns and numbers new ones after them", () => {
    expect(assignCallsigns(["main", "x", "x"], ["main", "x", null])).toEqual(["main", "x", "x#2"]);
    expect(assignCallsigns(["main", "main"], ["main", null])).toEqual(["main", "main#2"]);
  });

  it("never repeats a callsign", () => {
    expect(assignCallsigns(["x", "x", "x"], ["x#2", null, null])).toEqual(["x#2", "x#3", "x#4"]);
  });
});
