import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The `vscode` module exists only inside the editor's extension host. Tests load a small fake
// of the parts the extension uses instead (test/fakes/vscode.ts). Every test file first runs
// test/setup-env.ts, which points HOME, CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR at temporary
// folders (#211).
export default defineConfig({
  test: {
    setupFiles: ["./test/setup-env.ts"],
  },
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/fakes/vscode.ts", import.meta.url)),
    },
  },
});
