/**
 * Browser entry. Start-up selection (`startup.ts`): the editor tab's meta tag selects the
 * webview transport, a token in the page fragment selects the loopback HTTP transport (the
 * fragment is removed from the address bar before anything else runs), and otherwise the app
 * shows the bundled demo. `Root` falls back to the demo when a host lists no sessions.
 *
 * No inline script is needed: the host marks the page with meta tags only, so a strict
 * Content-Security-Policy that allows just this bundle works.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./generated/tokens.css";
import "./app.css";
import { Root } from "./Root";
import { startupFromPage, type StartupWindow } from "./startup";
import { parseStartOptions } from "./url-state";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing the #root element in index.html");
}

// Before React renders and before any request: reads and removes the link's fragment.
const startup = startupFromPage(window as Window & StartupWindow);

createRoot(container).render(
  <StrictMode>
    <Root startup={startup} startOptions={parseStartOptions(window.location.search)} />
  </StrictMode>,
);
