// ESLint flat config for the whole monorepo.
// Files are matched by glob, so a new package is linted without editing this file.
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // .vscode-test/ is where @vscode/test-electron downloads VS Code by default (#106).
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/.vscode-test/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Parameters prefixed with an underscore are intentionally unused (for example, the
    // VS Code activate() context while the extension does nothing).
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/*/test/**/*.{ts,tsx}", "scripts/**/*.test.mjs"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      // Type-level tests assert with expectTypeOf; tsc checks them under `npm run typecheck`.
      "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expectTypeOf"] }],
    },
  },
  prettier,
);
