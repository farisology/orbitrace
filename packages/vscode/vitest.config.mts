import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The `vscode` module exists only inside the editor's extension host. Tests load a small fake
// of the parts the extension uses instead (test/fakes/vscode.ts).
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/fakes/vscode.ts", import.meta.url)),
    },
  },
});
