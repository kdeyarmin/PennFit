// Phase 0 placeholder vitest config. Per-package config exists so
// `pnpm test` is consistent across every resupply-* package; real
// test suites land in Phase 1+ as features arrive.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
  },
});
