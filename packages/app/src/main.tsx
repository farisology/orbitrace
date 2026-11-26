/**
 * Browser entry. With no host (no editor extension, no CLI server) the app runs on the no-host
 * transport and shows the bundled demo. The editor tab (#12) and the browser host (#16) will
 * pass their own `HostTransport` here.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./generated/tokens.css";
import "./app.css";
import { App } from "./App";
import { createDemoTransport } from "./demo-session";
import { parseStartOptions } from "./url-state";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing the #root element in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App
      transport={createDemoTransport()}
      startOptions={parseStartOptions(window.location.search)}
    />
  </StrictMode>,
);
