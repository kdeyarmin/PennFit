// Vitest config for the storefront DB package. Mirrors
// `lib/resupply-db/vitest.config.ts` so `pnpm test` picks up suites
// from both `src/` and `scripts/` consistently across the workspace.
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
