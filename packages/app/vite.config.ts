import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the same build loads from an editor webview or a loopback server.
  base: "./",
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
  },
});
