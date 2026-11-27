/**
 * The demo golden replay: what core's real pipeline (parseSession, buildReplay) makes of the
 * synthetic `demo` fixture session, committed in fixtures/replays/. Invented data only. It is the
 * replay the app bundles, so the label tests check what a first-time user sees.
 */

import { assertReplay, type ReplayModel } from "@orbitrace/core";
import demo from "../../../../fixtures/replays/demo.replay.json" with { type: "json" };

const value: unknown = demo;
assertReplay(value);

export const DEMO_GOLDEN: ReplayModel = value;
