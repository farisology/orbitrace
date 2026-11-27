// Issue 203: the cache-write split reaches the inspector through each of the app's transports.
// The host side is core's own session replayer over the synthetic cache-write-split session, so
// the model the fake hosts send is exactly what the CLI and the editor send; the fake hosts carry
// it as JSON (HTTP) or by structured clone (editor). A replay file of the same session, opened in
// the app, has no split and shows the fallback note. Every value is invented.

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exportReplay,
  validateReplay,
  type ReplayModel,
  type SessionSummary,
} from "@orbitrace/core";
import { App } from "../src/App";
import { OrreryFactoryContext } from "../src/components/OrreryView";
import { DEFAULT_EXPORT_CHOICES, makeReplayFile } from "../src/export-replay";
import { createHttpTransport } from "../src/http-transport";
import { replayFromJson } from "../src/load-file";
import { createNoHostTransport } from "../src/no-host-transport";
import type { HostTransport } from "../src/transport";
import { createWebviewTransport } from "../src/webview-transport";
import { fakeFetch, fakeWebview, settle } from "./fake-hosts";
import { fakeOrrery, manualFrames } from "./helpers";
import { expectFallback, expectSplitRows, splitHost, type SplitHost } from "./ledger-split-session";

let host: SplitHost;

beforeAll(async () => {
  host = await splitHost();
});

afterAll(() => {
  host.remove();
});

function renderApp(transport: HostTransport) {
  const orrery = fakeOrrery();
  return render(
    <OrreryFactoryContext.Provider value={orrery.factory}>
      <App transport={transport} frames={manualFrames()} />
    </OrreryFactoryContext.Provider>,
  );
}

/** The inspector region for the whole session, once a replay is shown. */
async function sessionInspector(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Session" });
}

const summary = (live: SessionSummary["live"]): SessionSummary => ({ ...host.summary, live });

describe("the host's model (issue 203)", () => {
  it("carries the split and each reply's model, from load and from follow alike", () => {
    expect(host.followed).toEqual(host.loaded);
    const replies = host.loaded.agents.flatMap((agent) => agent.replies);
    expect(replies.some((reply) => reply.cacheWrite1hTokens !== undefined)).toBe(true);
    expect(replies.every((reply) => typeof reply.model === "string")).toBe(true);
  });
});

describe("the split in the inspector, through the HTTP transport (issue 203)", () => {
  it("for a session read once with loadReplay", async () => {
    const server = fakeFetch();
    server.rpc = (request) =>
      request.method === "loadReplay"
        ? { kind: "result", id: request.id, result: host.loaded }
        : { kind: "result", id: request.id, result: [summary("ended")] };
    renderApp(createHttpTransport({ token: "synthetic-token", fetch: server.fetch }));
    const inspector = await sessionInspector();
    expect(server.calls.map((call) => (call.body as { method?: string }).method)).toContain(
      "loadReplay",
    );
    expectSplitRows(inspector, host.expected);
  });

  it("for a session followed live, on the first update and on the next", async () => {
    const server = fakeFetch();
    server.rpc = (request) => ({ kind: "result", id: request.id, result: [summary("busy")] });
    renderApp(createHttpTransport({ token: "synthetic-token", fetch: server.fetch }));
    await waitFor(() => expect(server.streams).toHaveLength(1));
    const stream = server.streams[0];
    const { id } = stream?.call.body as { id: number };
    const send = async (replay: ReplayModel, live: SessionSummary["live"]) => {
      await act(async () => {
        stream?.send({
          kind: "live",
          subscriptionId: id,
          key: host.summary.key,
          update: { type: "replay", replay, live },
        });
        await settle();
      });
    };
    await send(host.followed, "busy");
    expectSplitRows(await sessionInspector(), host.expected);
    await send(host.followed, "idle");
    expectSplitRows(await sessionInspector(), host.expected);
  });
});

describe("the split in the inspector, through the editor's webview transport (issue 203)", () => {
  it("for a session followed live", async () => {
    const webview = fakeWebview();
    renderApp(createWebviewTransport({ api: webview.api, events: webview.events }));
    await waitFor(() => expect(webview.posted).toHaveLength(1));
    await act(async () => {
      webview.reply({ kind: "result", id: webview.posted[0]?.id, result: [summary("busy")] });
      await settle();
    });
    await waitFor(() => expect(webview.posted).toHaveLength(2));
    const subscription = webview.posted[1];
    expect(subscription?.method).toBe("subscribe");
    await act(async () => {
      webview.reply({
        kind: "live",
        subscriptionId: subscription?.id,
        key: host.summary.key,
        update: { type: "replay", replay: host.followed, live: "busy" },
      });
      await settle();
    });
    expectSplitRows(await sessionInspector(), host.expected);
  });

  it("for a session read once with loadReplay", async () => {
    const webview = fakeWebview();
    renderApp(createWebviewTransport({ api: webview.api, events: webview.events }));
    await waitFor(() => expect(webview.posted).toHaveLength(1));
    await act(async () => {
      webview.reply({ kind: "result", id: webview.posted[0]?.id, result: [summary("ended")] });
      await settle();
    });
    await waitFor(() => expect(webview.posted).toHaveLength(2));
    const load = webview.posted[1];
    expect(load?.method).toBe("loadReplay");
    await act(async () => {
      webview.reply({ kind: "result", id: load?.id, result: host.loaded });
      await settle();
    });
    expectSplitRows(await sessionInspector(), host.expected);
  });
});

describe("a replay file of the same session (issue 203)", () => {
  it("exports exactly the bytes of a build without details", () => {
    const file = makeReplayFile(host.loaded, DEFAULT_EXPORT_CHOICES);
    const plain = replayFromJson(file.data);
    if (!plain.ok) throw new Error("the export did not load as a replay file");
    expect(exportReplay(plain.model).data).toBe(file.data);
    expect(JSON.stringify(plain.model)).not.toContain("cacheWrite");
  });

  it("has no split, so the inspector shows the fallback note", async () => {
    const data = makeReplayFile(host.loaded, DEFAULT_EXPORT_CHOICES).data;
    expect(validateReplay(JSON.parse(data))).toBe(true);
    const transport = createNoHostTransport([
      { summary: summary("ended"), load: async () => JSON.parse(data) as unknown },
    ]);
    renderApp(transport);
    expectFallback(await sessionInspector());
  });
});
