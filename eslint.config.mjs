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
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
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
    rules: vitest.configs.recommended.rules,
  },
  prettier,
);
