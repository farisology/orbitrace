import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { thirdPartyNotices } from "./scripts/third-party-notices.mjs";

const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "..", "..");

/** `vite build --mode player` (`npm run build:player`) builds the public replay player. */
export const PLAYER_MODE = "player";

/**
 * The Content-Security-Policy of the public player page (docs/player.md), written into its
 * `<head>` as a meta tag by the player build.
 *
 * - `default-src 'self'`: scripts, styles, images and fonts come from the page's own origin
 *   only. No inline script or style element is allowed, and none is needed: the build has
 *   neither, and the app sets element styles through the DOM, which a policy does not block.
 * - `connect-src 'self'`: the only request the page makes is a same-origin `?replay=` link.
 * - `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`: no plugins, no `<base>`
 *   rewrite, no form posts.
 *
 * A file the visitor opens is read with the File API, which a policy does not restrict.
 * `frame-ancestors` cannot be set from a meta tag; a host that wants it sets it as a header.
 */
export const PLAYER_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const CHARSET_TAG = '<meta charset="UTF-8" />';

/** Writes the player's policy right after the charset tag, before any script or style. */
function playerCsp(): Plugin {
  return {
    name: "orbitrace-player-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => {
        if (!html.includes(CHARSET_TAG)) {
          throw new Error(`The player page must start its <head> with ${CHARSET_TAG}`);
        }
        return html.replace(
          CHARSET_TAG,
          `${CHARSET_TAG}\n    <meta http-equiv="Content-Security-Policy" content="${PLAYER_CSP}" />`,
        );
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const app = {
    // thirdPartyNotices writes THIRD-PARTY-NOTICES.txt next to index.html, and the module list
    // the release check reads (#143). See scripts/third-party-notices.mjs.
    plugins: [react(), thirdPartyNotices({ repoRoot, appDir: packageDir, moduleList: true })],
    // Relative asset URLs, so the same build loads from an editor webview or a loopback server.
    base: "./",
    server: { host: "127.0.0.1" },
    preview: { host: "127.0.0.1" },
    test: {
      environment: "happy-dom",
      setupFiles: ["./test/setup.ts"],
    },
  };
  if (mode !== PLAYER_MODE) return app;
  // The public player: its own page, src/player/index.html, and its own output folder. Relative
  // asset URLs, so it works from any sub-path of any static host. No service worker. The app
  // build above, which the editor and the CLI copy, is unchanged by this mode.
  return {
    ...app,
    // The player ships the notices too, but not the module list: no release check reads it.
    plugins: [
      react(),
      playerCsp(),
      thirdPartyNotices({ repoRoot, appDir: packageDir, moduleList: false }),
    ],
    root: resolve(packageDir, "src", "player"),
    publicDir: resolve(packageDir, "public"),
    build: { outDir: resolve(packageDir, "dist-player"), emptyOutDir: true },
  };
});
