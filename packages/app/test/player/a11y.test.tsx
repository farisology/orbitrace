// axe-core against the player's own states: start, loading a link, a refusal, and a replay
// opened from a file. Every value is invented.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { OrreryFactoryContext } from "../../src/components/OrreryView";
import type { FetchFunction } from "../../src/http-transport";
import { PLAYER_MESSAGES } from "../../src/player/messages";
import { Player, type PlayerProps } from "../../src/player/Player";
import { NO_START_OPTIONS } from "../../src/url-state";
import { axeProblems, useAppStyles } from "../axe";
import { fakeOrrery, makeModel, stillFrames } from "../helpers";

const ORIGIN = "https://player.example.test";
const page = (search = "") => ({ href: `${ORIGIN}/p/index.html${search}`, origin: ORIGIN, search });

beforeAll(() => {
  useAppStyles();
});

function renderPlayer(props: Partial<PlayerProps> = {}) {
  return render(
    <OrreryFactoryContext.Provider value={fakeOrrery().factory}>
      <Player
        page={page()}
        frames={stillFrames}
        startOptions={{ ...NO_START_OPTIONS, paused: true }}
        {...props}
      />
    </OrreryFactoryContext.Provider>,
  );
}

const pick = (container: HTMLElement, file: File) => {
  const input = container.querySelector('input[type="file"]');
  if (input === null) throw new Error("no file input");
  fireEvent.change(input, { target: { files: [file] } });
};

describe("axe-core: no WCAG 2.1 A or AA failures in the player", () => {
  it("start state", async () => {
    renderPlayer();
    expect(await axeProblems()).toEqual([]);
  });

  it("loading a linked replay", async () => {
    const never: FetchFunction = () => new Promise<Response>(() => {});
    renderPlayer({ page: page("?replay=a.replay.json"), fetch: never });
    expect(screen.getByRole("status").textContent).toBe(PLAYER_MESSAGES.loadingLink);
    expect(await axeProblems()).toEqual([]);
  });

  it("a cross-origin link refused", async () => {
    renderPlayer({ page: page("?replay=https%3A%2F%2Felsewhere.example.test%2Fa.json") });
    expect(screen.getByRole("alert")).toBeDefined();
    expect(await axeProblems()).toEqual([]);
  });

  it("a file that fails the schema refused, with its problem list", async () => {
    const { container } = renderPlayer();
    pick(container, new File(['{"formatVersion":1}'], "broken.replay.json"));
    await screen.findByRole("alert");
    expect(await axeProblems()).toEqual([]);
  });

  it("a replay opened from a file", async () => {
    const { container } = renderPlayer();
    pick(container, new File([JSON.stringify(makeModel())], "example.replay.json"));
    await screen.findByRole("list", { name: "Agents" });
    expect(await axeProblems()).toEqual([]);
  });

  it("a replay shown with a file over the size limit refused above it", async () => {
    const { container } = renderPlayer({ maxBytes: 1024 * 1024 });
    pick(container, new File([JSON.stringify(makeModel())], "example.replay.json"));
    await screen.findByRole("list", { name: "Agents" });
    const big = new File(["{}"], "large.replay.json");
    Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 });
    pick(container, big);
    await screen.findByRole("alert");
    expect(await axeProblems()).toEqual([]);
  });
});
