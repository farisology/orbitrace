/**
 * Entry of the public replay player (`npm run build:player`, written to `dist-player/`).
 *
 * Unlike the app's entry (`../main.tsx`), there is no host: no editor meta tag, no token in the
 * fragment, no loopback server. The page shows the player start screen, or a same-origin
 * replay named by `?replay=`. See docs/player.md.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../generated/tokens.css";
import "../app.css";
import "./player.css";
import { parseStartOptions } from "../url-state";
import { Player } from "./Player";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing the #root element in index.html");
}

const { href, origin, search } = window.location;

createRoot(container).render(
  <StrictMode>
    <Player page={{ href, origin, search }} startOptions={parseStartOptions(search)} />
  </StrictMode>,
);
