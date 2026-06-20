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

// Authenticated storage state written by admin-auth.setup.ts. Kept as a
// cwd-relative string (NOT computed via node:path/url): importing a node
// builtin into the Playwright config makes its per-file transpiler emit
// CJS interop (`exports`) that fails to load under the repo's ESM mode.
// The e2e suite is always launched from the repo root (see e2e/README.md
// + the CI jobs), so this resolves to <repo>/e2e/.auth/admin.json — the
// same path the setup writes (e2e/tests/admin/storage-state.ts).
const ADMIN_STORAGE_STATE = "e2e/.auth/admin.json";

const PORT = Number(process.env["E2E_PORT"] ?? 5173);
const BASE_URL = process.env["E2E_BASE_URL"] ?? `http://localhost:${PORT}`;

// The admin (backend-backed) suite is opt-in: it needs a live API +
// PostgREST stack and a seeded admin, which only the `e2e-admin` CI job
// (and a local operator who exports E2E_ADMIN) provides. When off, the
// default storefront project ignores the admin specs + auth setup so a
// plain `pnpm test:e2e` against `vite preview` stays green.
const ADMIN_ENABLED = !!process.env["E2E_ADMIN"];

const SETUP_MATCH = "**/admin-auth.setup.ts";
const ADMIN_MATCH = "**/admin/**/*.admin.spec.ts";

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
      // The storefront project never runs the admin specs or the auth
      // setup — those need the backend-backed stack.
      testIgnore: [SETUP_MATCH, ADMIN_MATCH],
      use: { ...devices["Desktop Chrome"] },
    },
    // Backend-backed admin projects, added only when E2E_ADMIN is set.
    // `admin` depends on `setup`, which signs in once and saves the
    // authenticated storage state every admin spec reuses.
    ...(ADMIN_ENABLED
      ? [
          {
            name: "setup",
            testMatch: SETUP_MATCH,
            use: { ...devices["Desktop Chrome"] },
          },
          {
            name: "admin",
            testMatch: ADMIN_MATCH,
            dependencies: ["setup"],
            use: {
              ...devices["Desktop Chrome"],
              storageState: ADMIN_STORAGE_STATE,
            },
          },
        ]
      : []),
  ],

  // The dev server is not auto-started; tests assume it's already
  // running on `BASE_URL`. Auto-starting it from Playwright would
  // duplicate the `pnpm dev` scripts already documented in the
  // README and tangle CI startup ordering. Document this in the
  // README when the suite grows beyond smoke tests.
});
