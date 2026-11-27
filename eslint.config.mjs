// ESLint flat config for the whole monorepo.
// Files are matched by glob, so a new package is linted without editing this file.
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * A package reaches another package by its name and a public entry, never by a relative path
 * into that package's src folder: such a path passes even when the entry it stands for is wrong
 * (#197, #213). From a file `depth` folders below `packages/<name>/`, exactly `depth` steps up
 * reach `packages/`, so one block per depth refuses `<that many ../><package>/src` and nothing in
 * the file's own package. Depths 1 to 6 cover every file under packages/ today (the deepest is 4).
 */
const crossPackageImports = [1, 2, 3, 4, 5, 6].map((depth) => ({
  files: [`packages/*/${"*/".repeat(depth - 1)}*.{ts,tsx,mts,cts,js,mjs,cjs}`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: `^(\\./)?(\\.\\./){${depth}}[^./][^/]*/src(/|$)`,
            message:
              "Import another package by its name and a public entry, not by a path into its src folder (#197, #213).",
          },
        ],
      },
    ],
  },
}));

export default defineConfig(
  {
    // .vscode-test/ is where @vscode/test-electron downloads VS Code by default (#106).
    // dist-player/ is the public replay player build of packages/app (#152).
    ignores: [
      "**/dist/**",
      "**/dist-player/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.vscode-test/**",
    ],
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
  ...crossPackageImports,
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
