// Phase 0 placeholder vitest config. Per-package config exists so
// `pnpm test` is consistent across every resupply-* package; real
// test suites land in Phase 1+ as features arrive.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    // The previous setup file seeded RESUPPLY_AUDIT_HMAC_KEY for the
    // HIPAA §164.312(b) tamper-evident audit chain. That feature was
    // retired with migration 0156 (@workspace/resupply-audit is now
    // a no-op stub), and no code path reads the key anymore.
    coverage: {
      // Permissive baseline so `pnpm test:coverage` exits non-zero
      // when a PR drops coverage below today's floor. Raise as the
      // suite grows. Per-file thresholds are intentionally absent —
      // the gate is on the aggregate so a single weakly-tested file
      // doesn't fail every PR until someone refactors.
      thresholds: {
        lines: 35,
        functions: 35,
        branches: 60,
        statements: 35,
      },
      // Exclude files we don't write tests against (boot stubs,
      // generated client types, type-only files, the worker
      // registration wrappers — the lib functions they call are
      // tested individually).
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/index.ts",
        "src/worker/index.ts",
        "src/test-helpers/**",
        "src/lib/voice/voice-config.ts",
      ],
    },
  },
});
