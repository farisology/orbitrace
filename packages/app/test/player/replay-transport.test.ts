// The transport for one opened replay. Every value is invented.

import { describe, expect, it } from "vitest";
import {
  PLAYER_REPLAY_KEY,
  createReplayTransport,
  replaySummary,
} from "../../src/player/replay-transport";
import { makeModel } from "../helpers";

describe("replay transport", () => {
  it("lists one ended session under the given label", async () => {
    const model = makeModel();
    const transport = createReplayTransport(model, "Replay file: example.replay.json");
    const listed = await transport.listSessions({ limit: 5 });
    expect(listed).toEqual([replaySummary(model, "Replay file: example.replay.json")]);
    expect(listed[0]?.live).toBe("ended");
    expect(listed[0]?.subagentCount).toBe(model.agents.length - 1);
  });

  it("serves the model it was given", async () => {
    const model = makeModel();
    const transport = createReplayTransport(model, "Linked replay");
    await expect(transport.loadReplay(PLAYER_REPLAY_KEY)).resolves.toBe(model);
    expect(transport.canOpenInBrowser).toBe(false);
  });
});
