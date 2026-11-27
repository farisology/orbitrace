import { EDITOR_HOST_META_VALUE, HOST_META_NAME, SESSION_META_NAME } from "@orbitrace/core";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { PANEL_VIEW_TYPE, PanelManager, panelId } from "../src/panels.js";
import { FAKE_CSP_SOURCE, fake } from "./fakes/vscode.js";
import { fakeReplayer, flush, makeRef, makeSummary } from "./helpers.js";

const INDEX = `<!doctype html><html><head><title>t</title><script type="module" src="./assets/a.js"></script></head><body></body></html>`;
const summary = makeSummary();

function setup(readIndexHtml: () => string = () => INDEX) {
  const replayer = fakeReplayer([makeRef(summary, "-workspace-kite-workshop")]);
  const manager = new PanelManager({
    extensionUri: vscode.Uri.file("/workspace/ext"),
    replayer,
    readIndexHtml,
  });
  return { manager, replayer };
}

beforeEach(() => {
  fake.reset();
});

describe("panelId", () => {
  it("keeps one id per session and one for the demo", () => {
    expect(panelId({ kind: "demo" })).toBe("demo");
    expect(panelId({ kind: "session", key: "claude-code:k", summary })).toBe(
      "session:claude-code:k",
    );
  });
});

describe("PanelManager", () => {
  it("opens a session tab limited to the app folder, with the policy and host tags", () => {
    const { manager } = setup();
    manager.open({ kind: "session", key: summary.key, summary });
    const panel = fake.panels[0];
    expect(panel?.viewType).toBe(PANEL_VIEW_TYPE);
    expect(panel?.title).toBe("Orbitrace: kite-workshop");
    expect(panel?.options).toMatchObject({
      enableScripts: true,
      enableForms: false,
      enableCommandUris: false,
      retainContextWhenHidden: true,
    });
    const roots = panel?.options.localResourceRoots as { path: string }[];
    expect(roots.map((root) => root.path)).toEqual(["/workspace/ext/dist/app"]);
    const html = panel?.webview.html ?? "";
    expect(html).toContain(`script-src ${FAKE_CSP_SOURCE}`);
    expect(html).toContain(`connect-src 'none'`);
    expect(html).toContain(
      `<base href="https:///webview-resource.example/workspace/ext/dist/app/">`,
    );
    expect(html).toContain(`<meta name="${HOST_META_NAME}" content="${EDITOR_HOST_META_VALUE}">`);
    expect(html).toContain(`<meta name="${SESSION_META_NAME}" content="${summary.key}">`);
  });

  it("reveals the open tab instead of opening a second one", () => {
    const { manager } = setup();
    const first = manager.open({ kind: "session", key: summary.key, summary });
    const again = manager.open({ kind: "session", key: summary.key, summary });
    expect(again).toBe(first);
    expect(fake.panels).toHaveLength(1);
    expect(fake.panels[0]?.revealCount).toBe(1);
    manager.open({ kind: "demo" });
    expect(manager.size).toBe(2);
  });

  it("answers the app's messages and disposes every subscription when the tab closes", async () => {
    const { manager, replayer } = setup();
    manager.open({ kind: "session", key: summary.key, summary });
    const panel = fake.panels[0];
    panel?.webview.receive({ id: 1, method: "listSessions", params: {} });
    panel?.webview.receive({ id: 2, method: "subscribe", params: { key: summary.key } });
    await flush();
    // Replies are matched by id; a quick reply may overtake a slower one.
    expect(panel?.webview.posted).toHaveLength(2);
    expect(panel?.webview.posted).toContainEqual({ kind: "result", id: 1, result: [summary] });
    expect(panel?.webview.posted).toContainEqual({ kind: "result", id: 2, result: null });
    expect(replayer.follows).toHaveLength(1);

    panel?.dispose();
    expect(replayer.follows[0]?.stopped).toBe(true);
    expect(panel?.webview.receiverCount).toBe(0);
    expect(manager.size).toBe(0);
    // A new tab opens after the old one closed.
    manager.open({ kind: "session", key: summary.key, summary });
    expect(fake.panels).toHaveLength(2);
  });

  it("gives the demo tab no host tags and no message host", async () => {
    const { manager, replayer } = setup();
    manager.open({ kind: "demo" });
    const panel = fake.panels[0];
    expect(panel?.title).toBe("Orbitrace: demo");
    expect(panel?.webview.html).not.toContain(HOST_META_NAME);
    expect(panel?.webview.receiverCount).toBe(0);
    panel?.webview.receive({ id: 1, method: "listSessions", params: {} });
    await flush();
    expect(panel?.webview.posted).toEqual([]);
    expect(replayer.listCalls).toBe(0);
  });

  it("opens no tab when the app is missing, and closes the tab when the page is refused", () => {
    const missing = setup(() => {
      throw new Error("missing");
    });
    expect(() => missing.manager.open({ kind: "demo" })).toThrow("missing");
    expect(fake.panels).toHaveLength(0);

    const inline = setup(() => "<html><head><script>x</script></head></html>");
    expect(() => inline.manager.open({ kind: "demo" })).toThrow(/inline script/);
    expect(fake.panels[0]?.disposed).toBe(true);
    expect(inline.manager.size).toBe(0);
  });

  it("dispose closes every tab", () => {
    const { manager } = setup();
    manager.open({ kind: "demo" });
    manager.open({ kind: "session", key: summary.key, summary });
    manager.dispose();
    expect(fake.panels.every((panel) => panel.disposed)).toBe(true);
    expect(manager.size).toBe(0);
  });
});
