# PennFit E2E (Playwright)

Browser-driven tests against the `cpap-fitter` SPA.

## Status

CI runs three Playwright signals:

- **Smoke** - required. Builds the SPA, serves it with `vite preview`, and runs `tests/storefront-loads.spec.ts`.
- **A11y** - soft-gated for now. Builds the SPA, serves it with `vite preview`, and runs `tests/a11y.spec.ts` against major public routes with axe.
- **Results resilience** - soft-gated for now. Boots the Vite dev server and runs `tests/results-page-resilience.spec.ts`, which needs unbundled modules to stub MediaPipe.

This is no longer just a scaffold, but it is still not representative coverage of the full storefront/admin workflow surface.

## Running Locally

1. Install the Chromium binary once:

   ```bash
   pnpm exec playwright install chromium
   ```

2. Start the cpap-fitter dev server:

   ```bash
   pnpm --filter @workspace/cpap-fitter dev
   ```

3. In another terminal, run the suite:

   ```bash
   pnpm run test:e2e
   pnpm run test:e2e:ui
   ```

The default base URL is `http://localhost:5173`. Override with:

```bash
E2E_BASE_URL=https://staging.pennpaps.com pnpm run test:e2e
```

## Backend-backed admin suite (`E2E_ADMIN`)

Most specs run against the storefront-only `vite preview` build (no API,
no DB). The **admin** suite is different: it needs the full runtime stack
and an authenticated session, so it is **opt-in** behind `E2E_ADMIN`.

- Specs live in `tests/admin/*.admin.spec.ts`; `tests/admin-auth.setup.ts`
  signs in once and saves the session to `e2e/.auth/admin.json`
  (git-ignored). Both the setup and the `admin` Playwright project resolve
  that path **relative to the repo root**, so always run the suite from
  the repo root.
- When `E2E_ADMIN` is unset, the default `chromium` project ignores the
  admin specs + setup, so a plain `pnpm run test:e2e` stays green without
  a backend.

CI runs this as the **`e2e-admin`** job (`.github/workflows/ci.yml`),
which stands up Postgres + standalone PostgREST (the service-role data
path), applies migrations, seeds an admin via `auth:set-admin-password`,
builds + starts the API (co-serving the built SPA), then runs:

```bash
E2E_ADMIN=1 E2E_BASE_URL=http://127.0.0.1:3000 \
  E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… \
  pnpm exec playwright test --config e2e/playwright.config.ts --project=admin
```

It is `continue-on-error` while the harness proves itself, mirroring the
`integration` + `a11y` soft-gate pattern. **To add a feature's admin e2e**
(e.g. the asset-recovery worklist), drop a
`tests/admin/<feature>.admin.spec.ts` — it inherits this project's auth +
stack automatically.

## Suggested Next Tests

In rough priority order, before this suite is "real":

1. Storefront -> cart -> mock-Stripe checkout success page.
2. Auth: sign-up, email verification, sign-in, and MFA challenge where applicable.
3. One customer account mutation that exercises signed-in CSRF.
4. ~~One admin mutation mounted through the full `app.ts` middleware chain.~~
   — covered by the `e2e-admin` job above; extend with feature specs.
5. Order placement with the insurance lead path.
