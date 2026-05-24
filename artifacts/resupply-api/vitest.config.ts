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
  },
});
