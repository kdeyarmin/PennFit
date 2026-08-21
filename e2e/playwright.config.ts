// Playwright config for PennFit storefront/admin SPA E2E.
//
// Scope: Storefront/admin SPA E2E. Current specs under tests/:
//   * storefront-loads.spec.ts      — SPA boots, landing nav renders
//   * home-trust-signals.spec.ts    — on-device privacy badge is present
//   * fitter-funnel-full.spec.ts    — the whole virtual mask fitter, happy
//                                     path + every recoverable failure
//   * results-page-resilience.spec.ts — measure/results page degrades
//                                       gracefully
//   * a11y.spec.ts                  — axe a11y sweep of public routes
//   * fitter-funnel-a11y.spec.ts    — axe sweep across the fitter funnel
//   * admin/*.admin.spec.ts         — authenticated admin (opt-in, E2E_ADMIN)
//
// Running the suite locally:
//   1. Install browser binaries once:
//        pnpm exec playwright install chromium
//   2. Run from the repo root:
//        pnpm run test:e2e
//
// The config below starts the Vite dev server automatically when nothing is
// already listening at BASE_URL. That keeps `pnpm run test:e2e` aligned with
// the cpap-fitter Vite config, which intentionally requires PORT + BASE_PATH
// in non-build modes.
//
// CI integration is wired in .github/workflows/ci.yml, and every
// storefront spec is gated:
//   * `smoke`   — storefront-loads.spec.ts against a `vite preview`
//                 build. Catches "the production bundle doesn't boot".
//   * `a11y`    — a11y.spec.ts against `vite preview`.
//   * `e2e-dev` — the WHOLE default project against `vite dev`, with no
//                 file filter. Specs that stub the @mediapipe/tasks-vision
//                 ES module only work unbundled, so they self-skip under
//                 preview; this job is where they actually execute. Adding
//                 a spec file under tests/ needs no CI change — which is
//                 the point, since naming files one at a time is what left
//                 three specs running in no job at all.
//   * `e2e-admin` — the `admin` project against the full backend stack
//                 (advisory; it pulls a third-party PostgREST binary).

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
const API_PROXY_TARGET =
  process.env["API_PROXY_TARGET"] ?? "http://localhost:3000";

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
  // In CI, "github" alone annotates the run summary but writes NOTHING to
  // disk — so the `Upload Playwright report on failure` steps in ci.yml found
  // no `playwright-report/` and silently uploaded nothing. Four Playwright
  // jobs (two of them required) could fail with no artifact to open. Pair it
  // with the html reporter so a failure leaves something to read; `open:
  // "never"` keeps it from trying to launch a browser on a runner.
  //
  // Traces and screenshots land under `test-results/` (see `trace` and
  // `screenshot` below) and ci.yml uploads that directory too — the trace is
  // usually the thing worth having for a failure that won't reproduce
  // locally.
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : "list",

  webServer: {
    command: "pnpm --filter @workspace/cpap-fitter dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      PORT: (() => {
        try {
          const u = new URL(BASE_URL);
          return u.port || String(PORT);
        } catch {
          return String(PORT);
        }
      })(),
      BASE_PATH: "/",
      API_PROXY_TARGET,
    },
  },

  // Playwright's default expect timeout is 5s. Nearly every route in this
  // SPA is lazy-loaded behind a Suspense fallback, and the `e2e-dev` job
  // drives the suite against the Vite *dev* server, which transforms a route
  // chunk on first request. A cold route can therefore take ~5s to paint —
  // right on the default — so an assertion that follows a redirect into an
  // unvisited route is a coin flip on a slow runner. That is a dev-server
  // cost, not a product one: production ships prebuilt chunks that load in
  // milliseconds, so waiting longer here hides nothing a user would feel.
  //
  // This only changes how long a FAILING assertion waits before giving up;
  // an assertion that will pass still resolves as soon as the element
  // appears, so the suite is no slower in the green case.
  expect: { timeout: 10_000 },

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

  // The dev server is auto-started by the `webServer` block above, not
  // assumed to be running. `reuseExistingServer: true` keeps that from
  // being disruptive: Playwright only launches vite when nothing already
  // answers at BASE_URL, so a local `pnpm dev` session is reused, and CI
  // — which starts vite itself and passes E2E_BASE_URL — is left alone.
});
