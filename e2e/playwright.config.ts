// Playwright config for PennFit storefront/admin SPA E2E.
//
// Scope: Storefront/admin SPA E2E. Current specs under tests/:
//   * storefront-loads.spec.ts      — SPA boots, landing nav renders
//   * results-page-resilience.spec.ts — measure/results page degrades
//                                       gracefully
//   * a11y.spec.ts                  — axe a11y sweep of public routes
//
// Running the suite locally:
//   1. Install browser binaries once:
//        pnpm exec playwright install chromium
//   2. Start the dev server (it must be running on
//      VITE_DEV_PORT, default 5173):
//        pnpm --filter @workspace/cpap-fitter dev
//   3. In another terminal:
//        pnpm run test:e2e
//
// CI integration is wired in .github/workflows/ci.yml: the `smoke`
// job runs storefront-loads.spec.ts against a `vite preview` build
// and is REQUIRED; the `a11y` job runs a11y.spec.ts and is currently
// `continue-on-error` (non-gating) while baseline violations are
// triaged. results-page-resilience.spec.ts is not yet wired into a
// CI job.

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
