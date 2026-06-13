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

## Suggested Next Tests

In rough priority order, before this suite is "real":

1. Storefront -> cart -> mock-Stripe checkout success page.
2. Auth: sign-up, email verification, sign-in, and MFA challenge where applicable.
3. One customer account mutation that exercises signed-in CSRF.
4. One admin mutation mounted through the full `app.ts` middleware chain.
5. Order placement with the insurance lead path.
