// Stage 1 vitest config for the in-house auth library. Mirrors the
// pattern used by every other resupply-* package so `pnpm -r test`
// stays uniform.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
  },
});
