// Playwright config for PennFit storefront/admin SPA E2E.
//
// Scope: This is a minimal scaffold added in the post-Phase-4
// follow-up (AUDIT_REPORT.md #5). It contains one smoke test
// (`tests/storefront-loads.spec.ts`) that confirms the cpap-fitter
// SPA boots and renders its landing page.
//
// Running the suite:
//   1. Install browser binaries once:
//        pnpm exec playwright install chromium
//   2. Start the dev server (it must be running on
//      VITE_DEV_PORT, default 5173):
//        pnpm --filter @workspace/cpap-fitter dev
//   3. In another terminal:
//        pnpm run test:e2e
//
// CI integration is intentionally NOT wired in this scaffold —
// running Playwright in CI requires picking a runner image with the
// browser binaries cached (or paying the ~500 MB cold-install cost
// per run) and deciding whether to gate PRs on it. That decision is
// out of scope for this audit; the scaffold is here so the next
// step is purely operational (write more tests, wire CI).

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["E2E_PORT"] ?? 5173);
const BASE_URL = process.env["E2E_BASE_URL"] ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  // Two retries in CI smooths over flake from the dev-server proxy /
  // network jitter; locally, fail fast.
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: process.env["CI"] ? "github" : "list",

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // The dev server is not auto-started; tests assume it's already
  // running on `BASE_URL`. Auto-starting it from Playwright would
  // duplicate the `pnpm dev` scripts already documented in the
  // README and tangle CI startup ordering. Document this in the
  // README when the suite grows beyond smoke tests.
});
