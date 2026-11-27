// The public player page: start state, demo, opening and refusing files, the size limit, the
// `?replay=` link, and untrusted strings. Every value, host and file name is invented.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReplayModel } from "@orbitrace/core";
import { App } from "../../src/App";
import { OrreryFactoryContext } from "../../src/components/OrreryView";
import { FILE_MESSAGES } from "../../src/load-file";
import type { FetchFunction } from "../../src/http-transport";
import { EXPORT_COMMAND, EXPORT_DOCS_URL, PLAYER_MESSAGES } from "../../src/player/messages";
import { Player, type PlayerProps } from "../../src/player/Player";
import { NO_START_OPTIONS } from "../../src/url-state";
import {
  DEMO,
  fakeOrrery,
  makeModel,
  replayUpdate,
  scriptedHost,
  stillFrames,
  SUMMARY,
} from "../helpers";

const ORIGIN = "https://player.example.test";
const page = (search = "") => ({
  href: `${ORIGIN}/orbitrace/index.html${search}`,
  origin: ORIGIN,
  search,
});

function renderPlayer(props: Partial<PlayerProps> = {}) {
  const orrery = fakeOrrery();
  const view = render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <Player
        page={page()}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, paused: true }}
        {...props}
      />
    </OrreryFactoryContext.Provider>,
  );
  return { ...view, orrery };
}

const replayFile = (model: unknown, name = "example.replay.json") =>
  new File([JSON.stringify(model)], name, { type: "application/json" });

/** The file input the player listens to (its own, or the app's once a replay is shown). */
const fileInput = (container: HTMLElement) => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  return input;
};

const pick = (container: HTMLElement, file: File) =>
  fireEvent.change(fileInput(container), { target: { files: [file] } });

const drop = (target: Element, file: File) =>
  fireEvent.drop(target, { dataTransfer: { files: [file], types: ["Files"] } });

describe("start state", () => {
  it("invites the visitor to open or drop a replay, offers the demo, and says how to make one", () => {
    renderPlayer();
    expect(screen.getByRole("heading", { level: 2, name: PLAYER_MESSAGES.title })).toBeDefined();
    expect(screen.getByText(PLAYER_MESSAGES.intro)).toBeDefined();
    expect(screen.getByRole("button", { name: PLAYER_MESSAGES.openButton })).toBeDefined();
    expect(screen.getByRole("button", { name: PLAYER_MESSAGES.demoButton })).toBeDefined();
    expect(screen.getByText(PLAYER_MESSAGES.privacy)).toBeDefined();
    expect(screen.getByText("Files up to 50 MB.")).toBeDefined();
    expect(screen.getByText(EXPORT_COMMAND).tagName).toBe("CODE");
    const link = screen.getByRole("link", { name: PLAYER_MESSAGES.ownReplayLink });
    expect(link.getAttribute("href")).toBe(EXPORT_DOCS_URL);
    expect(link.getAttribute("rel")).toBe("noreferrer");
    // Nothing is loaded until the visitor chooses.
    expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
  });

  it("states the size limit it was given", () => {
    renderPlayer({ maxBytes: 2 * 1024 * 1024 });
    expect(screen.getByText("Files up to 2 MB.")).toBeDefined();
  });

  it("opens the file picker from the Open button", () => {
    const { container } = renderPlayer();
    const click = vi.spyOn(fileInput(container), "click");
    fireEvent.click(screen.getByRole("button", { name: PLAYER_MESSAGES.openButton }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("shows the bundled demo only when asked", async () => {
    renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: PLAYER_MESSAGES.demoButton }));
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.getByText("Demo session")).toBeDefined();
  });
});

describe("opening a file", () => {
  it("shows a picked replay, labelled with its file name", async () => {
    const { container, orrery } = renderPlayer();
    pick(container, replayFile(makeModel()));
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.getByText("Replay file: example.replay.json")).toBeDefined();
    expect(orrery.calls.some((call) => call.method === "setModel")).toBe(true);
  });

  it("shows a dropped replay and the drop overlay while dragging", async () => {
    const { container } = renderPlayer();
    const root = container.querySelector(".player");
    if (root === null) throw new Error("no player root");
    fireEvent.dragEnter(root, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByText(/Drop to open/)).toBeDefined();
    drop(root, replayFile(DEMO, "demo-copy.replay.json"));
    expect(screen.queryByText(/Drop to open/)).toBeNull();
    await screen.findByText("Replay file: demo-copy.replay.json");
  });

  it("refuses a file that fails the schema, with the readable problem list, and stays on start", async () => {
    const { container } = renderPlayer();
    pick(container, replayFile({ formatVersion: 1, agents: [] }, "broken.replay.json"));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(FILE_MESSAGES.invalidReplay)).toBeDefined();
    expect(within(alert).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 2, name: PLAYER_MESSAGES.title })).toBeDefined();
    fireEvent.click(within(alert).getByRole("button", { name: PLAYER_MESSAGES.dismiss }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: PLAYER_MESSAGES.openButton }),
    );
  });

  it("refuses a file over the size limit before reading it, and says the limit", async () => {
    const { container } = renderPlayer({ maxBytes: 1024 * 1024 });
    const file = replayFile(makeModel());
    Object.defineProperty(file, "size", { value: 3 * 1024 * 1024 });
    const text = vi.spyOn(file, "text");
    pick(container, file);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This file is 3 MB, larger than the 1 MB limit");
    expect(text).not.toHaveBeenCalled();
  });

  it("puts the app's own Open file input and drop area through the same checks", async () => {
    const { container } = renderPlayer({ maxBytes: 1024 * 1024 });
    pick(container, replayFile(makeModel()));
    await screen.findByText("Replay file: example.replay.json");

    // The app's Open file input: a file over the limit is refused by the player.
    const big = replayFile(makeModel(), "large.replay.json");
    Object.defineProperty(big, "size", { value: 2 * 1024 * 1024 });
    pick(container, big);
    expect((await screen.findByRole("alert")).textContent).toContain("1 MB limit");
    expect(screen.getByText("Replay file: example.replay.json")).toBeDefined();

    // Dismiss returns focus to the app's Open file button.
    fireEvent.click(screen.getByRole("button", { name: PLAYER_MESSAGES.dismiss }));
    expect(document.activeElement?.textContent).toBe("Open file");

    // The app's drop area: a valid file replaces the replay; the app's own overlay never shows.
    const appRoot = container.querySelector(".app");
    if (appRoot === null) throw new Error("no app");
    fireEvent.dragEnter(appRoot, { dataTransfer: { types: ["Files"] } });
    expect(screen.getAllByText(/Drop to open/)).toHaveLength(1);
    drop(appRoot, replayFile(makeModel(), "second.replay.json"));
    await screen.findByText("Replay file: second.replay.json");
  });
});

describe("replay files only (decided on #19)", () => {
  const transcriptFile = () =>
    new File(
      [`${JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z" })}\n`],
      "example-session.jsonl",
    );

  it("the start screen's file input offers replay files only", () => {
    const { container } = renderPlayer();
    expect(fileInput(container).getAttribute("accept")).toBe(".json,application/json");
  });

  it("refuses a picked transcript before reading it, says to export a replay, and stays on start", async () => {
    const { container } = renderPlayer();
    const file = transcriptFile();
    const text = vi.spyOn(file, "text");
    pick(container, file);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(PLAYER_MESSAGES.transcriptRefused)).toBeDefined();
    expect(within(alert).getByText(PLAYER_MESSAGES.transcriptRefusedHelp)).toBeDefined();
    expect(alert.textContent).toContain(EXPORT_COMMAND);
    expect(alert.textContent).not.toContain("example-session");
    expect(text).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: PLAYER_MESSAGES.title })).toBeDefined();
  });

  it("refuses a dropped transcript the same way", async () => {
    const { container } = renderPlayer();
    const root = container.querySelector(".player");
    if (root === null) throw new Error("no player root");
    drop(root, transcriptFile());
    expect((await screen.findByRole("alert")).textContent).toContain(
      PLAYER_MESSAGES.transcriptRefused,
    );
    expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
  });

  it("the app's Open file inside the player offers and opens replay files only", async () => {
    const { container } = renderPlayer();
    pick(container, replayFile(makeModel()));
    await screen.findByText("Replay file: example.replay.json");
    const input = fileInput(container);
    expect(input.getAttribute("accept")).toBe(".json,application/json");
    expect(input.getAttribute("aria-label")).toBe("Open a replay file");
    pick(container, transcriptFile());
    expect((await screen.findByRole("alert")).textContent).toContain(
      PLAYER_MESSAGES.transcriptRefused,
    );
    // The replay shown before stays.
    expect(screen.getByText("Replay file: example.replay.json")).toBeDefined();
  });
});

describe("?replay= link", () => {
  const okFetch = (model: unknown) =>
    vi.fn<FetchFunction>(async (input) => {
      const res = new Response(JSON.stringify(model), { status: 200 });
      Object.defineProperty(res, "url", { value: input });
      return res;
    });

  it("fetches a same-origin replay next to the player and shows it", async () => {
    const fetchFn = okFetch(makeModel());
    renderPlayer({ page: page("?replay=replays/shared.replay.json"), fetch: fetchFn });
    expect(screen.getByText(PLAYER_MESSAGES.loadingLink)).toBeDefined();
    await screen.findByText("Linked replay: shared.replay.json");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${ORIGIN}/orbitrace/replays/shared.replay.json`);
  });

  it("refuses a cross-origin link with a message and never fetches it", () => {
    const fetchFn = okFetch(makeModel());
    renderPlayer({
      page: page(`?replay=${encodeURIComponent("https://elsewhere.example.test/a.replay.json")}`),
      fetch: fetchFn,
    });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(PLAYER_MESSAGES.linkCrossOrigin)).toBeDefined();
    expect(within(alert).getByText(PLAYER_MESSAGES.linkCrossOriginHelp)).toBeDefined();
    expect(screen.getByRole("button", { name: PLAYER_MESSAGES.openButton })).toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("goes back to the start state when the linked file fails the schema", async () => {
    renderPlayer({ page: page("?replay=bad.replay.json"), fetch: okFetch({ formatVersion: 1 }) });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(FILE_MESSAGES.invalidReplay)).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: PLAYER_MESSAGES.title })).toBeDefined();
  });

  it("applies the link's start options to the linked replay", async () => {
    renderPlayer({
      page: page("?replay=a.replay.json&select=a1"),
      fetch: okFetch(makeModel()),
      startOptions: { ...NO_START_OPTIONS, paused: true, select: "a1" },
    });
    // a1 of the synthetic model: the inspector opens on it.
    expect(await screen.findByRole("heading", { name: "widget-explorer" })).toBeDefined();
  });
});

describe("a refused file while a link is still loading", () => {
  it("leaves the loading state, shows the refusal and brings the Open button back", async () => {
    const fetchFn = vi.fn<FetchFunction>(() => new Promise<Response>(() => {}));
    const { container } = renderPlayer({ page: page("?replay=slow.replay.json"), fetch: fetchFn });
    expect(screen.getByText(PLAYER_MESSAGES.loadingLink)).toBeDefined();
    expect(screen.queryByRole("button", { name: PLAYER_MESSAGES.openButton })).toBeNull();

    const root = container.querySelector(".player");
    if (root === null) throw new Error("no player root");
    drop(root, replayFile({ formatVersion: 1, agents: [] }, "broken.replay.json"));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(FILE_MESSAGES.invalidReplay)).toBeDefined();
    expect(screen.getByRole("button", { name: PLAYER_MESSAGES.openButton })).toBeDefined();
    expect(screen.queryByText(PLAYER_MESSAGES.loadingLink)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does the same for a file over the size limit", async () => {
    const fetchFn = vi.fn<FetchFunction>(() => new Promise<Response>(() => {}));
    const { container } = renderPlayer({
      page: page("?replay=slow.replay.json"),
      fetch: fetchFn,
      maxBytes: 1024 * 1024,
    });
    const big = replayFile(makeModel(), "large.replay.json");
    Object.defineProperty(big, "size", { value: 2 * 1024 * 1024 });
    const root = container.querySelector(".player");
    if (root === null) throw new Error("no player root");
    drop(root, big);
    expect((await screen.findByRole("alert")).textContent).toContain("1 MB limit");
    expect(screen.getByRole("button", { name: PLAYER_MESSAGES.openButton })).toBeDefined();
  });
});

describe("focus after a replay opens (WCAG 2.4.3)", () => {
  const appOpenButton = () => screen.getByRole("button", { name: "Open file" });

  it("moves to the app's Open file button after opening from the start screen", async () => {
    const { container } = renderPlayer();
    screen.getByRole("button", { name: PLAYER_MESSAGES.openButton }).focus();
    pick(container, replayFile(makeModel()));
    await screen.findByText("Replay file: example.replay.json");
    await waitFor(() => expect(document.activeElement).toBe(appOpenButton()));
  });

  it("moves to the app's Open file button after the demo", async () => {
    renderPlayer();
    const demo = screen.getByRole("button", { name: PLAYER_MESSAGES.demoButton });
    demo.focus();
    fireEvent.click(demo);
    await screen.findByText("Demo session");
    await waitFor(() => expect(document.activeElement).toBe(appOpenButton()));
  });

  it("stays on the app's Open file button when a second file replaces the replay", async () => {
    const { container } = renderPlayer();
    pick(container, replayFile(makeModel()));
    await screen.findByText("Replay file: example.replay.json");
    const first = appOpenButton();
    first.focus();
    pick(container, replayFile(makeModel(), "second.replay.json"));
    await screen.findByText("Replay file: second.replay.json");
    // The app remounts for each replay: a new button, and focus is on it.
    const second = appOpenButton();
    expect(second).not.toBe(first);
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it("does not move focus for a ?replay= link opened on page load", async () => {
    const fetchFn = vi.fn<FetchFunction>(async (input) => {
      const res = new Response(JSON.stringify(makeModel()), { status: 200 });
      Object.defineProperty(res, "url", { value: input });
      return res;
    });
    renderPlayer({ page: page("?replay=shared.replay.json"), fetch: fetchFn });
    await screen.findByText("Linked replay: shared.replay.json");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("untrusted strings reach the page as text, never as HTML", () => {
  const MARKUP = '<img src="x" data-injected="1"><b data-injected="1">bold</b>';

  it("shows a file name with markup as text", async () => {
    const { container } = renderPlayer();
    pick(container, replayFile(makeModel(), `${MARKUP}.replay.json`));
    await screen.findByText(`Replay file: ${MARKUP}.replay.json`);
    expect(container.querySelector("[data-injected]")).toBeNull();
  });

  it("shows a linked file name with markup as text", async () => {
    const fetchFn = vi.fn<FetchFunction>(async (input) => {
      const res = new Response(JSON.stringify(makeModel()), { status: 200 });
      Object.defineProperty(res, "url", { value: input });
      return res;
    });
    const { container } = renderPlayer({
      page: page(`?replay=${encodeURIComponent(encodeURIComponent(MARKUP))}`),
      fetch: fetchFn,
    });
    await screen.findByText(`Linked replay: ${MARKUP}`);
    expect(container.querySelector("[data-injected]")).toBeNull();
  });

  /** A replay whose agent and tool names carry markup. */
  function markupModel(): ReplayModel {
    const model = makeModel();
    return {
      ...model,
      agents: model.agents.map((agent) => ({
        ...agent,
        name: `${MARKUP}${agent.name}`,
        callsign: `${MARKUP}${agent.callsign}`,
        tools: agent.tools.map((tool) => ({ ...tool, name: `${MARKUP}${tool.name}` })),
      })),
    } as unknown as ReplayModel;
  }

  it("refuses a replay whose names contain markup (the schema allows identifiers only)", async () => {
    const { container } = renderPlayer();
    pick(container, replayFile(markupModel(), "markup.replay.json"));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(FILE_MESSAGES.invalidReplay)).toBeDefined();
    // The problem list never quotes a value from the file.
    expect(alert.textContent).not.toContain("data-injected");
    expect(container.querySelector("[data-injected]")).toBeNull();
  });

  it("would render such names as text even past the schema check", async () => {
    const host = scriptedHost([SUMMARY]);
    const { container } = render(
      <OrreryFactoryContext.Provider value={fakeOrrery().factory}>
        <App
          transport={host}
          sessions={[SUMMARY]}
          sessionKey={SUMMARY.key}
          onSessionChange={() => {}}
          frames={stillFrames}
          startOptions={{ ...NO_START_OPTIONS, paused: true, select: "a1", time: 59 }}
        />
      </OrreryFactoryContext.Provider>,
    );
    await waitFor(() => expect(host.subscribed).toHaveLength(1));
    act(() => host.push(replayUpdate(markupModel(), "ended")));
    await screen.findByRole("list", { name: "Agents" });
    expect(container.textContent).toContain(MARKUP);
    expect(container.querySelector("[data-injected]")).toBeNull();
  });
});

describe("no export (issue 168)", () => {
  it("has no Export control, for a picked replay or the demo", async () => {
    const { container } = renderPlayer();
    pick(container, replayFile(makeModel()));
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
