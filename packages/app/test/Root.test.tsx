import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@orbitrace/core";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { createDemoTransport } from "../src/demo-session";
import { HTTP_MESSAGES, createHttpTransport } from "../src/http-transport";
import { ROOT_MESSAGES, Root, SESSION_LIST_LIMIT } from "../src/Root";
import type { Startup } from "../src/startup";
import type { HostTransport } from "../src/transport";
import { NO_START_OPTIONS } from "../src/url-state";
import {
  SUMMARY,
  fakeOrrery,
  makeModel,
  replayUpdate,
  scriptedHost,
  stillFrames,
  type FakeOrrery,
} from "./helpers";
import { fakeFetch, settle } from "./fake-hosts";

const ENDED: SessionSummary = {
  ...SUMMARY,
  key: "session-2",
  projectLabel: "example-gadgets",
  live: "ended",
  lastActivity: 0,
  subagentCount: null,
};

function host(transport: HostTransport, sessionKey: string | null = null): Startup {
  return { kind: "host", host: "browser", transport, sessionKey };
}

function renderRoot(startup: Startup, orrery: FakeOrrery = fakeOrrery()) {
  render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <Root
        startup={startup}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, paused: true }}
      />
    </OrreryFactoryContext.Provider>,
  );
  return orrery;
}

/** The open session list (opened first when it is closed). */
const picker = () => {
  const toggle = screen.getByRole("button", { name: /^Sessions \(/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return screen.getByRole("list", { name: "Sessions" });
};
const sessionButton = (label: string) =>
  within(picker()).getByRole("button", { name: new RegExp(`^${label}`) });

describe("start-up selection", () => {
  it("demo: shows the bundled demo with no session picker", async () => {
    renderRoot({ kind: "demo", transport: createDemoTransport() });
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.getByText("Demo session")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();
    expect(screen.queryByText(ROOT_MESSAGES.emptyHost)).toBeNull();
  });

  it("host with no sessions: falls back to the demo and says why", async () => {
    const empty = scriptedHost([]);
    renderRoot(host(empty));
    expect(screen.getByText(ROOT_MESSAGES.connecting)).toBeDefined();
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.getByText("Demo session")).toBeDefined();
    expect(screen.getByText(ROOT_MESSAGES.emptyHost)).toBeDefined();
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();
    expect(empty.listSessions).toHaveBeenCalledWith({ limit: SESSION_LIST_LIMIT });
    expect(empty.subscribed).toEqual([]);
  });

  it("host with sessions: opens the newest and lists them in the picker", async () => {
    const scripted = scriptedHost([SUMMARY, ENDED]);
    renderRoot(host(scripted));
    await waitFor(() => expect(scripted.subscribed).toEqual(["session-1"]));
    act(() => scripted.push(replayUpdate(makeModel(), "busy")));
    expect(screen.getAllByText("example-project").length).toBeGreaterThan(0);
    expect(sessionButton("example-project").getAttribute("aria-current")).toBe("true");
    expect(sessionButton("example-gadgets").getAttribute("aria-current")).toBeNull();
  });

  it("host with a preselected session opens that one", async () => {
    const scripted = scriptedHost([SUMMARY, ENDED]);
    renderRoot(host(scripted, "session-2"));
    // Listed as ended: read once, not followed.
    await screen.findByRole("list", { name: "Agents" });
    expect(scripted.loadReplay).toHaveBeenCalledWith("session-2");
    expect(scripted.subscribed).toEqual([]);
    expect(sessionButton("example-gadgets").getAttribute("aria-current")).toBe("true");
  });

  it("refused token: a plain error page, not the demo", async () => {
    const refused = {
      ...scriptedHost(),
      listSessions: vi.fn(() =>
        Promise.reject({ code: "unauthorized", message: HTTP_MESSAGES.refused }),
      ),
    };
    renderRoot(host(refused));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ROOT_MESSAGES.refusedTitle);
    expect(alert.textContent).toContain(ROOT_MESSAGES.refusedBody);
    expect(alert.textContent).toContain("(unauthorized)");
    expect(screen.queryByText("Demo session")).toBeNull();
  });

  it("any other listing failure: a plain error page with the host's message", async () => {
    const failing = {
      ...scriptedHost(),
      listSessions: vi.fn(() => Promise.reject(new Error("synthetic detail"))),
    };
    renderRoot(host(failing));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ROOT_MESSAGES.failedTitle);
    expect(alert.textContent).toContain(ROOT_MESSAGES.listFailed);
    expect(alert.textContent).not.toContain("synthetic detail");
  });

  it("a start-up that failed before listing shows its error", () => {
    renderRoot({ kind: "failed", error: { code: "unsupported", message: "No editor API." } });
    expect(screen.getByRole("alert").textContent).toContain("No editor API.");
  });
});

describe("session picker in the app", () => {
  it("switches sessions: stops following the old one and reads the new one", async () => {
    const scripted = scriptedHost([SUMMARY, ENDED]);
    const orrery = renderRoot(host(scripted));
    await waitFor(() => expect(scripted.subscribed).toEqual(["session-1"]));
    act(() => scripted.push(replayUpdate(makeModel(), "busy")));
    fireEvent.click(sessionButton("example-gadgets"));
    await waitFor(() => expect(scripted.loadReplay).toHaveBeenCalledWith("session-2"));
    expect(scripted.unsubscribed).toBe(1);
    await waitFor(() =>
      expect(sessionButton("example-gadgets").getAttribute("aria-current")).toBe("true"),
    );
    expect(screen.getByText("Replay")).toBeDefined();
    // A different replay: a new setModel, not an update.
    expect(orrery.methods().filter((m) => m === "setModel")).toHaveLength(2);
  });

  it("picking the shown session again reads it again", async () => {
    const scripted = scriptedHost([SUMMARY, ENDED]);
    renderRoot(host(scripted, "session-2"));
    await screen.findByRole("list", { name: "Agents" });
    expect(scripted.loadReplay).toHaveBeenCalledTimes(1);
    fireEvent.click(sessionButton("example-gadgets"));
    await waitFor(() => expect(scripted.loadReplay).toHaveBeenCalledTimes(2));
  });
});

describe("live session through Root", () => {
  it("feeds later snapshots to updateModel, keeping the selection and time, with a Live marker", async () => {
    const scripted = scriptedHost([SUMMARY]);
    const orrery = renderRoot(host(scripted));
    await waitFor(() => expect(scripted.subscribed).toEqual(["session-1"]));
    act(() => scripted.push(replayUpdate(makeModel(40), "busy")));
    const marker = screen.getByText("Live: working");
    expect(marker.closest(".badge")?.className).toContain("badge-live");
    // The start options say paused, so the view does not follow: it says how far behind it is.
    expect(marker.textContent).toBe("Live: working, 10 min 40 s behind");
    act(() => orrery.emit("select", { agentId: "a1" }));
    const scrubber = screen.getByRole("slider", { name: "Replay position" }) as HTMLInputElement;
    fireEvent.change(scrubber, { target: { value: "12" } });
    act(() => scripted.push(replayUpdate(makeModel(55), "idle")));
    expect(orrery.methods().filter((m) => m === "setModel")).toHaveLength(1);
    expect(orrery.last("updateModel")?.[0]).toEqual(makeModel(55));
    expect(screen.getByRole("heading", { name: "widget-explorer" })).toBeDefined();
    expect(scrubber.value).toBe("12");
    expect(scrubber.max).toBe("55");
    act(() => scripted.push({ type: "ended" }));
    expect(screen.getByText("Replay").closest(".badge")?.className).not.toContain("badge-live");
  });

  it("works end to end over the HTTP transport with a streamed live response", async () => {
    const server = fakeFetch();
    server.rpc = (request) => ({ kind: "result", id: request.id, result: [SUMMARY] });
    const transport = createHttpTransport({ token: "synthetic-token", fetch: server.fetch });
    const orrery = renderRoot(host(transport));
    await waitFor(() => expect(server.streams).toHaveLength(1));
    const stream = server.streams[0];
    const body = stream?.call.body as { id: number };
    await act(async () => {
      stream?.send({
        kind: "live",
        subscriptionId: body.id,
        key: SUMMARY.key,
        update: { type: "replay", replay: makeModel(30), live: "busy" },
      });
      await settle();
    });
    await screen.findByRole("list", { name: "Agents" });
    act(() => orrery.emit("select", { agentId: "a2" }));
    await act(async () => {
      stream?.send({
        kind: "live",
        subscriptionId: body.id,
        key: SUMMARY.key,
        update: { type: "replay", replay: makeModel(45), live: "busy" },
      });
      await settle();
    });
    expect(orrery.methods()).toContain("updateModel");
    expect(screen.getByRole("heading", { name: "gadget-builder" })).toBeDefined();
    expect(screen.getByText("Live: working")).toBeDefined();
  });
});
