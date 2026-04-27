// Phase 0 placeholder vitest config. Per-package config exists so
// `pnpm test` is consistent across every resupply-* package; real
// test suites land in Phase 1+ as features arrive.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.{test,spec}.ts",
      // The migrate runner lives under `scripts/` (it's a `.mjs`
      // intentionally kept off the TypeScript build path so it can run
      // before `pnpm install` has built the workspace). Its
      // integration test sits next to it so `pnpm test` exercises it.
      "scripts/**/*.{test,spec}.ts",
    ],
  },
});
