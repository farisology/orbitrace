import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@orbitrace/core";
import { SessionPicker, isLiveStatus } from "../src/components/SessionPicker";
import { SUMMARY } from "./helpers";

const NOW = 10 * 60 * 60 * 1000;
const SESSIONS: SessionSummary[] = [
  { ...SUMMARY, key: "s1", projectLabel: "example-project", lastActivity: NOW - 5 * 60 * 1000 },
  {
    ...SUMMARY,
    key: "s2",
    projectLabel: "example-gadgets",
    live: "ended",
    lastActivity: NOW - 3 * 60 * 60 * 1000,
    subagentCount: null,
  },
];

describe("SessionPicker", () => {
  it("lists every session with its age, subagents and live status, and marks the shown one", () => {
    render(<SessionPicker sessions={SESSIONS} currentKey="s2" onSelect={() => {}} now={NOW} />);
    const toggle = screen.getByRole("button", { name: "Sessions (2)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = within(screen.getByRole("list", { name: "Sessions" })).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("example-project");
    expect(items[0]?.textContent).toContain("5 min ago, 2 subagents");
    expect(items[0]?.textContent).toContain("Live");
    expect(items[0]?.getAttribute("aria-current")).toBeNull();
    expect(items[1]?.textContent).toContain("3 h ago");
    expect(items[1]?.textContent).not.toContain("subagent");
    expect(items[1]?.textContent).not.toContain("Live");
    expect(items[1]?.textContent).toContain("Shown");
    expect(items[1]?.getAttribute("aria-current")).toBe("true");
  });

  it("calls onSelect with the picked key and closes", () => {
    const onSelect = vi.fn();
    render(
      <SessionPicker sessions={SESSIONS} currentKey={undefined} onSelect={onSelect} now={NOW} />,
    );
    const toggle = screen.getByRole("button", { name: "Sessions (2)" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /^example-gadgets/ }));
    expect(onSelect).toHaveBeenCalledWith("s2");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();
    expect(screen.queryByText("Shown")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("treats busy and idle as live", () => {
    expect(isLiveStatus("busy")).toBe(true);
    expect(isLiveStatus("idle")).toBe(true);
    expect(isLiveStatus("ended")).toBe(false);
    expect(isLiveStatus("unknown")).toBe(false);
  });
});
