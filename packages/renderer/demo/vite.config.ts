// Dev server for the renderer demo page: `npm run dev` in packages/renderer.
// @orbitrace/core resolves to its built dist, so run `npm run build` at the repository root first.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
