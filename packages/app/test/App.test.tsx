import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, APP_MESSAGES, liveLabel, sourceLabel } from "../src/App";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { createDemoTransport } from "../src/demo-session";
import { FILE_MESSAGES } from "../src/load-file";
import { createNoHostTransport } from "../src/no-host-transport";
import type { HostTransport } from "../src/transport";
import { NO_START_OPTIONS, type StartOptions } from "../src/url-state";
import {
  DEMO,
  SUMMARY,
  fakeOrrery,
  makeModel,
  replayUpdate,
  scriptedHost,
  stillFrames,
  type FakeOrrery,
} from "./helpers";

function renderApp(
  transport: HostTransport,
  options: { start?: Partial<StartOptions>; orrery?: FakeOrrery; sessionKey?: string } = {},
) {
  const orrery = options.orrery ?? fakeOrrery();
  const result = render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <App
        transport={transport}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, ...options.start }}
        {...(options.sessionKey !== undefined ? { sessionKey: options.sessionKey } : {})}
      />
    </OrreryFactoryContext.Provider>,
  );
  return { ...result, orrery };
}

const scrubber = () => screen.getByRole("slider", { name: "Replay position" }) as HTMLInputElement;
const playButton = () => screen.getByRole("button", { name: /^(Play|Pause)$/ });
const lane = (callsign: string) =>
  within(screen.getByRole("list", { name: "Agents" })).getByRole("button", {
    name: new RegExp(`^${callsign}`),
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App with no host", () => {
  it("loads the bundled demo session", async () => {
    const { orrery } = renderApp(createDemoTransport());
    expect(screen.getByRole("status")).toHaveProperty("textContent", APP_MESSAGES.loading);
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.getByText("Demo session")).toBeDefined();
    expect(screen.getByText("Replay")).toBeDefined();
    expect(
      within(screen.getByRole("list", { name: "Agents" })).getAllByRole("listitem"),
    ).toHaveLength(DEMO.agents.length);
    expect(orrery.methods()).toContain("setModel");
    expect(orrery.last("setModel")?.[0]).toEqual(DEMO);
    // Autoplay: the clock started and the renderer was told.
    expect(playButton().textContent).toContain("Pause");
    expect(orrery.methods()).toContain("play");
    expect(
      screen.getByRole("img", { name: /14 subagents in orbit, 208 tool calls/ }),
    ).toBeDefined();
  });

  it("starts where the URL asks, with the agent selected and paused", async () => {
    const { orrery } = renderApp(createDemoTransport(), {
      start: { time: 200, select: "a5", paused: true, rate: 16 },
    });
    await screen.findByRole("heading", { name: "lantern-builder#1" });
    expect(Number(scrubber().value)).toBe(200);
    expect(playButton().textContent).toContain("Play");
    expect(orrery.last("select")).toEqual(["a5"]);
    expect(orrery.last("setSpeed")).toEqual([16]);
    expect((screen.getByRole("combobox", { name: "Speed" }) as HTMLSelectElement).value).toBe("16");
    expect(lane("lantern-builder#1").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("inspector", () => {
  it("shows session totals with nothing selected, and an agent once selected", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    const inspector = screen.getByRole("region", { name: "Session" });
    expect(within(inspector).getByText(/Select an agent/)).toBeDefined();

    fireEvent.click(lane("widget-explorer"));
    const agent = screen.getByRole("region", { name: "Agent" });
    expect(within(agent).getByRole("heading", { name: "widget-explorer" })).toBeDefined();
    expect(within(agent).getByText("Haiku")).toBeDefined();
    expect(within(agent).getByText("(triangle)")).toBeDefined();
    expect(within(agent).getByText("low")).toBeDefined();
    expect(within(agent).getByText("Wave 1")).toBeDefined();
    expect(within(agent).getByText("Not started")).toBeDefined();
    // Start 4 s and end 20 s, both before the idle cut, so real time equals compressed time.
    expect(within(agent).getByText("0:04")).toBeDefined();
    expect(within(agent).getByText("0:20")).toBeDefined();
    const kinds = within(agent).getByRole("table", { name: "Tool calls by kind" });
    const shell = within(kinds).getByRole("row", { name: /Shell/ });
    expect(
      within(shell)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["2", "1"]);
    const tokens = within(agent).getByRole("table", { name: "Tokens" });
    expect(within(tokens).getByRole("row", { name: /Output/ }).textContent).toContain("1,200");

    fireEvent.click(within(agent).getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("region", { name: "Session" })).toBeDefined();
  });

  it("shows real times after an idle cut and a running agent", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true, select: "a2", time: 50 } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    const agent = screen.getByRole("region", { name: "Agent" });
    expect(within(agent).getByText("still running")).toBeDefined();
    expect(within(agent).getByText("Running")).toBeDefined();
    expect(within(agent).getByText("not recorded")).toBeDefined();
    // 50 s on the compressed timeline is 650 s real (one 600 s cut at 30 s).
    expect(
      screen.getByRole("slider", { name: "Replay position" }).getAttribute("aria-valuetext"),
    ).toBe("10:50 of 11:00, real time");
  });

  it("follows a selection made on the canvas", async () => {
    const host = scriptedHost();
    const { orrery } = renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    act(() => orrery.emit("select", { agentId: "a2" }));
    expect(screen.getByRole("heading", { name: "gadget-builder" })).toBeDefined();
    expect(orrery.last("select")).toEqual(["a2"]);
    act(() => orrery.emit("select", { agentId: null }));
    expect(screen.getByRole("region", { name: "Session" })).toBeDefined();
  });
});

/** Wait until the app has subscribed to the scripted host. */
async function subscribed(host: ReturnType<typeof scriptedHost>): Promise<void> {
  await waitFor(() => expect(host.subscribed.length).toBeGreaterThan(0));
}

describe("keyboard", () => {
  it("space plays and pauses, arrows scrub, Home and End jump, Escape clears", async () => {
    const host = scriptedHost();
    const { orrery } = renderApp(host, { start: { paused: true, time: 10, select: "a1" } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    expect(playButton().textContent).toContain("Play");

    fireEvent.keyDown(document.body, { key: " " });
    expect(playButton().textContent).toContain("Pause");
    expect(orrery.last("play")).toEqual([]);
    fireEvent.keyDown(document.body, { key: " " });
    expect(playButton().textContent).toContain("Play");

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(Number(scrubber().value)).toBe(15);
    expect(orrery.last("setTime")).toEqual([15]);
    fireEvent.keyDown(document.body, { key: "ArrowLeft", shiftKey: true });
    expect(Number(scrubber().value)).toBe(0);
    fireEvent.keyDown(document.body, { key: "End" });
    expect(Number(scrubber().value)).toBe(60);
    fireEvent.keyDown(document.body, { key: "Home" });
    expect(Number(scrubber().value)).toBe(0);

    expect(screen.getByRole("region", { name: "Agent" })).toBeDefined();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Session" })).toBeDefined();
  });

  it("leaves keys typed into a control to that control", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true, time: 10 } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Speed" }), { key: "ArrowRight" });
    expect(Number(scrubber().value)).toBe(10);
    fireEvent.keyDown(lane("main"), { key: " " });
    expect(playButton().textContent).toContain("Play");
    fireEvent.keyDown(scrubber(), { key: "ArrowRight" });
    expect(Number(scrubber().value)).toBe(10);
  });

  it("space on the focused scrubber still plays and pauses", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true, time: 10 } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    scrubber().focus();
    fireEvent.keyDown(scrubber(), { key: " " });
    expect(playButton().textContent).toContain("Pause");
    fireEvent.keyDown(scrubber(), { key: "k" });
    expect(playButton().textContent).toContain("Play");
  });
});

describe("controls and timeline", () => {
  it("play button, speed and scrubber drive the clock and the renderer", async () => {
    const host = scriptedHost();
    const { orrery } = renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    fireEvent.click(playButton());
    expect(playButton().textContent).toContain("Pause");
    fireEvent.click(playButton());
    expect(orrery.last("pause")).toEqual([]);
    fireEvent.change(screen.getByRole("combobox", { name: "Speed" }), { target: { value: "32" } });
    expect(orrery.last("setSpeed")).toEqual([32]);
    fireEvent.change(scrubber(), { target: { value: "42" } });
    expect(orrery.last("setTime")).toEqual([42]);
    expect(screen.getByText("10:42 of 11:00")).toBeDefined();
  });

  it("marks idle skips and jumps to one", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    const mark = screen.getByRole("button", { name: /Idle skip at 0:30: 10 min cut/ });
    fireEvent.click(mark);
    expect(Number(scrubber().value)).toBe(30);
  });

  it("shows failed calls on the lane label", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    expect(within(lane("widget-explorer")).getByLabelText("1 failed")).toBeDefined();
  });
});

describe("event feed", () => {
  it("shows events up to now, newest first, and jumps to one", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true, time: 0 } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    const feed = screen.getByRole("region", { name: "Events" });
    expect(within(feed).getByText("No events yet. Press play.")).toBeDefined();

    fireEvent.keyDown(document.body, { key: "End" });
    const items = within(feed).getAllByRole("button");
    expect(items[0]?.textContent).toContain("Idle skip");
    const failures = within(feed).getByRole("button", {
      name: /2 failed calls: Bash ×2 in main, widget-explorer/,
    });
    fireEvent.click(failures);
    expect(Number(scrubber().value)).toBe(25);
    const handback = within(feed).queryByRole("button", { name: /handed back/ });
    expect(handback).not.toBeNull();
  });
});

describe("dropped files", () => {
  const drop = (file: File) => {
    const app = document.querySelector(".app") as HTMLElement;
    fireEvent.dragEnter(app, { dataTransfer: { types: ["Files"], files: [file] } });
    fireEvent.drop(app, { dataTransfer: { types: ["Files"], files: [file] } });
  };

  it("shows a dropped replay and stops following the host", async () => {
    const host = scriptedHost();
    const { orrery } = renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    drop(new File([JSON.stringify(DEMO)], "shared.replay.json"));
    await screen.findByText("Replay file: shared.replay.json");
    expect(host.unsubscribed).toBe(1);
    expect(orrery.last("setModel")?.[0]).toEqual(DEMO);
    expect(
      within(screen.getByRole("list", { name: "Agents" })).getAllByRole("listitem"),
    ).toHaveLength(15);
  });

  it("explains why an invalid file was rejected and keeps the current replay", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    drop(new File([JSON.stringify({ formatVersion: 1, agents: [] })], "broken.replay.json"));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(FILE_MESSAGES.invalidReplay)).toBeDefined();
    expect(within(alert).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: "Agents" })).toBeDefined();
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rejects an unsupported file type", async () => {
    renderApp(createNoHostTransport([]));
    await screen.findByText(APP_MESSAGES.empty);
    drop(new File(["x"], "notes.txt"));
    expect(await screen.findByText(FILE_MESSAGES.unsupported)).toBeDefined();
  });

  it("opens a transcript picked with the file button, main agent only", async () => {
    renderApp(createNoHostTransport([]));
    await screen.findByText(APP_MESSAGES.empty);
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T10:00:00.000Z",
      message: {
        id: "msg_synthetic",
        model: "claude-haiku-4-5",
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: "tool_use", id: "toolu_synthetic", name: "Grep", input: {} }],
      },
    });
    const input = screen.getByLabelText("Open a replay or transcript file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([`${line}\n`], "session.jsonl")] } });
    await screen.findByText("Transcript: session.jsonl");
    expect(screen.getByText(APP_MESSAGES.transcriptNote)).toBeDefined();
    expect(
      within(screen.getByRole("list", { name: "Agents" })).getAllByRole("listitem"),
    ).toHaveLength(1);
  });

  it("shows the drop overlay while a file is dragged over", async () => {
    renderApp(createNoHostTransport([]));
    await screen.findByText(APP_MESSAGES.empty);
    const app = document.querySelector(".app") as HTMLElement;
    fireEvent.dragEnter(app, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByText(APP_MESSAGES.dropHere)).toBeDefined();
    fireEvent.dragLeave(app, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.queryByText(APP_MESSAGES.dropHere)).toBeNull();
  });
});

describe("host states", () => {
  it("shows an empty state when the host lists no sessions", async () => {
    renderApp(createNoHostTransport([]));
    expect(await screen.findByText(APP_MESSAGES.empty)).toBeDefined();
    expect(screen.getByText(APP_MESSAGES.dropHint)).toBeDefined();
  });

  it("shows the host's error when listing fails", async () => {
    const transport = {
      ...createNoHostTransport([]),
      listSessions: () =>
        Promise.reject({ code: "unauthorized", message: "The link has expired." }),
    };
    renderApp(transport);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The link has expired.");
    expect(alert.textContent).toContain("(unauthorized)");
  });

  it("hides anything that is not a transport error behind a fixed message", async () => {
    const transport = {
      ...createNoHostTransport([]),
      listSessions: () => Promise.reject(new Error("synthetic secret detail")),
    };
    renderApp(transport);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(APP_MESSAGES.hostFailed);
    expect(alert.textContent).not.toContain("synthetic secret detail");
  });

  it("shows the error of a session that cannot be built", async () => {
    const host = scriptedHost();
    renderApp(host);
    await subscribed(host);
    act(() =>
      host.push({
        type: "error",
        error: { code: "unreadable", message: "The session transcript could not be read." },
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("could not be read");
  });

  it("opens the session it is given without listing", async () => {
    const host = scriptedHost();
    renderApp(host, { sessionKey: "session-9" });
    await waitFor(() => expect(host.subscribed).toEqual(["session-9"]));
    expect(host.listSessions).not.toHaveBeenCalled();
  });
});

describe("live session", () => {
  it("sets the first model and updates with later snapshots, keeping the selection", async () => {
    const host = scriptedHost();
    const { orrery } = renderApp(host, { start: { paused: true, select: "a1" } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel(40), "busy")));
    expect(screen.getByText("example-project")).toBeDefined();
    expect(screen.getByText("Live: working")).toBeDefined();
    act(() => host.push(replayUpdate(makeModel(50), "idle")));
    expect(orrery.methods().filter((m) => m === "setModel")).toHaveLength(1);
    expect(orrery.methods()).toContain("updateModel");
    expect(screen.getByText("Live: idle")).toBeDefined();
    expect(scrubber().max).toBe("50");
    expect(screen.getByRole("heading", { name: "widget-explorer" })).toBeDefined();
    act(() => host.push({ type: "ended" }));
    expect(screen.getByText("Replay")).toBeDefined();
  });

  it("shows a later error as an alert over the current replay", async () => {
    const host = scriptedHost();
    renderApp(host, { start: { paused: true } });
    await subscribed(host);
    act(() => host.push(replayUpdate(makeModel())));
    act(() =>
      host.push({ type: "error", error: { code: "internal", message: "Watching stopped." } }),
    );
    expect(screen.getByRole("alert").textContent).toContain("Watching stopped.");
    expect(screen.getByRole("list", { name: "Agents" })).toBeDefined();
  });
});

describe("reduced motion", () => {
  it("does not autoplay and tells the renderer", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { orrery } = renderApp(createDemoTransport());
    await screen.findByRole("list", { name: "Agents" });
    expect(playButton().textContent).toContain("Play");
    expect(orrery.calls.find((c) => c.method === "create")?.args[0]).toEqual({
      reducedMotion: true,
    });
    expect(orrery.methods()).not.toContain("play");
  });
});

describe("labels", () => {
  it("names the source and the live status", () => {
    expect(sourceLabel({ kind: "host", label: "example-project", live: "busy" })).toBe(
      "example-project",
    );
    expect(sourceLabel({ kind: "file", fileKind: "replay", name: "a.replay.json" })).toBe(
      "Replay file: a.replay.json",
    );
    expect(sourceLabel({ kind: "file", fileKind: "transcript", name: "a.jsonl" })).toBe(
      "Transcript: a.jsonl",
    );
    expect(liveLabel("busy")).toBe("Live: working");
    expect(liveLabel("idle")).toBe("Live: idle");
    expect(liveLabel("ended")).toBe("Replay");
    expect(liveLabel("unknown")).toBeNull();
  });

  it("uses the summary's project label for a listed session", () => {
    expect(SUMMARY.projectLabel).toBe("example-project");
  });
});
