// axe-core against the rendered app in each main state. Every value is invented.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@orbitrace/core";
import { App } from "../src/App";
import { OrreryFactoryContext, type OrreryFactory } from "../src/components/OrreryView";
import { createDemoTransport } from "../src/demo-session";
import { transportError } from "../src/no-host-transport";
import { ROOT_MESSAGES, Root } from "../src/Root";
import type { Startup } from "../src/startup";
import type { HostTransport } from "../src/transport";
import { NO_START_OPTIONS, type StartOptions } from "../src/url-state";
import { axeProblems, useAppStyles } from "./axe";
import { SUMMARY, fakeOrrery, makeModel, replayUpdate, scriptedHost, stillFrames } from "./helpers";

const SESSIONS: SessionSummary[] = [
  SUMMARY,
  { ...SUMMARY, key: "session-2", projectLabel: "example-gadgets", live: "ended" },
];

beforeAll(() => {
  useAppStyles();
});

function renderApp(
  transport: HostTransport,
  options: {
    start?: Partial<StartOptions>;
    factory?: OrreryFactory;
    sessions?: readonly SessionSummary[];
  } = {},
) {
  return render(
    <OrreryFactoryContext.Provider value={options.factory ?? fakeOrrery().factory}>
      <App
        transport={transport}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, paused: true, ...options.start }}
        {...(options.sessions !== undefined
          ? {
              sessions: options.sessions,
              sessionKey: options.sessions[0]?.key ?? "",
              onSessionChange: () => {},
            }
          : {})}
      />
    </OrreryFactoryContext.Provider>,
  );
}

describe("axe-core: no WCAG 2.1 A or AA failures", () => {
  it("demo loaded", async () => {
    renderApp(createDemoTransport());
    await screen.findByRole("list", { name: "Agents" });
    expect(await axeProblems()).toEqual([]);
  });

  it("demo loaded and playing at the end, with every event in the feed", async () => {
    renderApp(createDemoTransport(), { start: { paused: false } });
    await screen.findByRole("list", { name: "Agents" });
    fireEvent.keyDown(document.body, { key: "End" });
    expect(
      within(screen.getByRole("region", { name: "Events" })).getAllByRole("button").length,
    ).toBeGreaterThan(10);
    expect(await axeProblems()).toEqual([]);
  });

  it("export dialog open on a live session, with a bad rounding step (issue 168)", async () => {
    const host = scriptedHost(SESSIONS);
    const saver = { kind: "download" as const, save: async () => "downloaded" as const };
    render(
      <OrreryFactoryContext.Provider value={fakeOrrery().factory}>
        <App
          transport={host}
          frames={stillFrames}
          startOptions={{ ...NO_START_OPTIONS, paused: true }}
          saver={saver}
        />
      </OrreryFactoryContext.Provider>,
    );
    await vi.waitFor(() => expect(host.subscribed).toHaveLength(1));
    act(() => host.push(replayUpdate(makeModel(), "busy")));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const dialog = screen.getByRole("dialog", { name: "Export replay" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Round times" }));
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Step in seconds" }), {
      target: { value: "0" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download replay" }));
    expect(within(dialog).getByText(/^The step must be/)).toBeDefined();
    expect(await axeProblems()).toEqual([]);
  });

  it("agent selected", async () => {
    renderApp(createDemoTransport(), { start: { select: "a5", time: 200 } });
    await screen.findByRole("heading", { name: "lantern-builder#1" });
    expect(await axeProblems()).toEqual([]);
  });

  it("live host session with the session picker open", async () => {
    const host = scriptedHost(SESSIONS);
    renderApp(host, { sessions: SESSIONS });
    await vi.waitFor(() => expect(host.subscribed).toHaveLength(1));
    act(() => host.push(replayUpdate(makeModel(), "busy")));
    expect(screen.getByText("Live: working")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sessions (2)" }));
    expect(screen.getByRole("list", { name: "Sessions" })).toBeDefined();
    expect(await axeProblems()).toEqual([]);
  });

  it("live host session following the live edge (Go live marked unavailable)", async () => {
    const host = scriptedHost(SESSIONS);
    renderApp(host, { sessions: SESSIONS, start: { paused: false } });
    await vi.waitFor(() => expect(host.subscribed).toHaveLength(1));
    act(() => host.push(replayUpdate(makeModel(), "busy")));
    expect(screen.getByText("Live: working").textContent).toBe("Live: working, following");
    expect(screen.getByRole("button", { name: "Go live" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(await axeProblems()).toEqual([]);
  });

  it("live host session behind the live edge, with Go live available", async () => {
    const host = scriptedHost(SESSIONS);
    renderApp(host, { sessions: SESSIONS, start: { paused: false } });
    await vi.waitFor(() => expect(host.subscribed).toHaveLength(1));
    act(() => host.push(replayUpdate(makeModel(), "idle")));
    fireEvent.keyDown(document.body, { key: "ArrowLeft", shiftKey: true });
    expect(screen.getByText("Live: idle").textContent).toMatch(/behind$/);
    expect(screen.getByRole("button", { name: "Go live" }).getAttribute("aria-disabled")).toBe(
      "false",
    );
    expect(await axeProblems()).toEqual([]);
  });

  it("error state: the host cannot load the session", async () => {
    const host: HostTransport = {
      ...scriptedHost(),
      loadReplay: async () => {
        throw transportError("not-found", "That session is gone.");
      },
    };
    renderApp(host, { sessions: [{ ...SUMMARY, live: "ended" }] });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("That session is gone."),
    );
    expect(await axeProblems()).toEqual([]);
  });

  it("error state: a host error while a session is shown", async () => {
    const host = scriptedHost();
    renderApp(host, { sessions: [SUMMARY] });
    await vi.waitFor(() => expect(host.subscribed).toHaveLength(1));
    act(() => host.push(replayUpdate(makeModel())));
    act(() =>
      host.push({ type: "error", error: transportError("internal", "The session went away.") }),
    );
    await screen.findByRole("alert");
    expect(await axeProblems()).toEqual([]);
  });

  it("error state: a dropped file that is not a replay", async () => {
    const { container } = renderApp(createDemoTransport());
    await screen.findByRole("list", { name: "Agents" });
    const app = container.querySelector(".app");
    if (app === null) throw new Error("no app");
    const file = new File([JSON.stringify({ formatVersion: 1, agents: [] })], "broken.replay.json");
    fireEvent.drop(app, { dataTransfer: { files: [file], types: ["Files"] } });
    await screen.findByRole("alert");
    expect(await axeProblems()).toEqual([]);
  });

  it("error state: the start-up page when the token is refused", async () => {
    const startup: Startup = {
      kind: "failed",
      error: transportError("unauthorized", "Refused."),
    };
    render(<Root startup={startup} frames={stillFrames} />);
    expect(screen.getByRole("alert").textContent).toContain(ROOT_MESSAGES.refusedTitle);
    expect(await axeProblems()).toEqual([]);
  });

  it("empty state: the host lists no sessions", async () => {
    renderApp(scriptedHost([]));
    expect(await screen.findByText("No session to show.")).toBeDefined();
    expect(await axeProblems()).toEqual([]);
  });

  it("connecting state", async () => {
    const startup: Startup = {
      kind: "host",
      host: "browser",
      transport: { ...scriptedHost(), listSessions: () => new Promise(() => {}) },
      sessionKey: null,
    };
    render(<Root startup={startup} frames={stillFrames} />);
    expect(screen.getByRole("status").textContent).toBe(ROOT_MESSAGES.connecting);
    expect(await axeProblems()).toEqual([]);
  });

  it("the orrery could not start (no 2D canvas)", async () => {
    renderApp(createDemoTransport(), {
      factory: () => {
        throw new Error("no 2D context");
      },
    });
    await screen.findByRole("list", { name: "Agents" });
    expect(await axeProblems()).toEqual([]);
  });
});

describe("axe-core canary", () => {
  it("still reports known failures with the app styles loaded", async () => {
    renderApp(createDemoTransport());
    await screen.findByRole("list", { name: "Agents" });
    const styles = [...document.head.querySelectorAll("style")].map((el) => el.textContent);
    expect(styles.join("\n")).toContain(":root :focus-visible");
    const hidden = document.querySelector(".visually-hidden");
    expect(hidden === null ? "" : getComputedStyle(hidden).position).toBe("absolute");
    const main = document.querySelector("main");
    if (main === null) throw new Error("no main");
    const broken = document.createElement("div");
    broken.innerHTML =
      '<button type="button" class="feed-item"></button><span class="lane-fail" aria-label="2 failed">2</span><img src="x.png">';
    main.append(broken);
    const problems = (await axeProblems()).join("\n");
    expect(problems).toContain("violation button-name");
    expect(problems).toContain("violation image-alt");
    expect(problems).toContain("aria-prohibited-attr");
    broken.remove();
  });
});
