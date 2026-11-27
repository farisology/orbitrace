// Benchmarks in Node: `npm run bench:node` in packages/renderer, after `npm run build` at the
// repository root. Not part of `npm test`: the files end in `.perf.ts`, which the default test
// run does not pick up. See docs/performance.md for what each file measures.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["perf/**/*.perf.ts"],
    // The report is printed with console.log; the default reporter always shows it.
    reporters: ["default"],
    // One file at a time, so two benchmarks never share the CPU.
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
