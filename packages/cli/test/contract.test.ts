// Proves the contract from ticket #2 is importable from another package, the way wave-B
// tickets will import it. Type-level checks run under `npm run typecheck`.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  REPLAY_BUILD_DEFAULTS,
  REPLAY_FORMAT_VERSION,
  type BuildReplay,
  type BuildReplayOptions,
  type ExportReplay,
  type ListSessions,
  type ParseSession,
  type ReplayAgentId,
  type ReplayModel,
  type ResolveSources,
  type SessionSummary,
  type SourceAdapter,
  type ValidateReplay,
} from "@orbitrace/core";
import type { CreateOrrery, OrreryHandle } from "@orbitrace/renderer";
import type {
  LiveRequest as CoreLiveRequest,
  TransportMessage as CoreTransportMessage,
  TransportRequest as CoreTransportRequest,
} from "@orbitrace/core";
import type {
  HostTransport,
  LiveUpdate,
  TransportMessage,
  TransportRequest,
} from "@orbitrace/app/transport";
import type { LiveRequest } from "../src/server/rpc.js";

describe("contract imports", () => {
  it("exposes the core runtime constants", () => {
    expect(REPLAY_FORMAT_VERSION).toBe(1);
    expect(REPLAY_BUILD_DEFAULTS).toEqual({
      idleGapSeconds: 45,
      idleKeepSeconds: 8,
      waveGapSeconds: 60,
    });
  });

  it("exposes the core signatures", () => {
    expectTypeOf<ParseSession>().toBeFunction();
    expectTypeOf<BuildReplay>().toBeFunction();
    expectTypeOf<NonNullable<BuildReplayOptions["previous"]>>().toEqualTypeOf<ReplayModel>();
    expectTypeOf<ResolveSources>().toBeFunction();
    expectTypeOf<ListSessions>().toBeFunction();
    expectTypeOf<ExportReplay>().toBeFunction();
    expectTypeOf<ValidateReplay>().toBeFunction();
    expectTypeOf<SourceAdapter["runtime"]>().toEqualTypeOf<"claude-code">();
  });

  it("lets the renderer take a replay model", () => {
    expectTypeOf<ReturnType<CreateOrrery>>().toEqualTypeOf<OrreryHandle>();
    expectTypeOf<Parameters<OrreryHandle["setModel"]>[0]>().toEqualTypeOf<ReplayModel>();
    expectTypeOf<Parameters<OrreryHandle["updateModel"]>[0]>().toEqualTypeOf<ReplayModel>();
    expectTypeOf<Parameters<OrreryHandle["select"]>[0]>().toEqualTypeOf<ReplayAgentId | null>();
  });

  it("lets a host implement the app transport", () => {
    expectTypeOf<ReturnType<HostTransport["loadReplay"]>>().toEqualTypeOf<Promise<ReplayModel>>();
    expectTypeOf<ReturnType<HostTransport["listSessions"]>>().toEqualTypeOf<
      Promise<readonly SessionSummary[]>
    >();
    expectTypeOf<Extract<LiveUpdate, { type: "replay" }>["replay"]>().toEqualTypeOf<ReplayModel>();
    expectTypeOf<TransportRequest["method"]>().toEqualTypeOf<
      "listSessions" | "loadReplay" | "subscribe" | "unsubscribe" | "openInBrowser"
    >();
    expectTypeOf<Extract<TransportRequest, { method: "unsubscribe" }>["params"]>().toEqualTypeOf<{
      readonly subscriptionId: number;
    }>();
    expectTypeOf<
      Extract<TransportMessage, { kind: "live" }>["subscriptionId"]
    >().toEqualTypeOf<number>();
  });

  it("types the server's messages from core, the same types the app re-exports (#96)", () => {
    expectTypeOf<CoreTransportRequest>().toEqualTypeOf<TransportRequest>();
    expectTypeOf<CoreTransportMessage>().toEqualTypeOf<TransportMessage>();
    expectTypeOf<LiveRequest>().toEqualTypeOf<CoreLiveRequest>();
  });
});
