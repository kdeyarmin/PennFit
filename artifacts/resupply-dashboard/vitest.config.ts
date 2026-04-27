// Standalone vitest config so `pnpm test` does not try to load
// vite.config.ts, which throws unless PORT and BASE_PATH are set
// (those are dev-server concerns and shouldn't gate the test runner).
//
// When real test files land in Phase 4+, add a `test:` block here
// (jsdom env, setup files, etc.). Phase 0 only needs an empty
// vitest invocation that exits 0.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
