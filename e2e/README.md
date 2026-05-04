# PennFit E2E (Playwright)

Browser-driven smoke tests against the cpap-fitter SPA. Added in the
audit's post-Phase-4 follow-up (see `AUDIT_REPORT.md` #5).

## Status

**Scaffold only.** One smoke test
(`tests/storefront-loads.spec.ts`) verifies the React app mounts on
the storefront landing page. This is a starting point, not a
representative coverage of the storefront/admin flows.

## Running locally

1. Install the Chromium binary once (~120 MB):
   ```bash
   pnpm exec playwright install chromium
   ```
2. Start the cpap-fitter dev server:
   ```bash
   pnpm --filter @workspace/cpap-fitter dev
   ```
3. In another terminal, run the suite:
   ```bash
   pnpm run test:e2e         # headless
   pnpm run test:e2e:ui      # Playwright UI mode
   ```

The default base URL is `http://localhost:5173`. Override with:

```bash
E2E_BASE_URL=https://staging.pennpaps.com pnpm run test:e2e
```

## CI

Not wired. Running Playwright in CI requires:

- A runner image with the browser binaries cached (or accepting the
  ~500 MB cold-install cost per run).
- A decision on whether to gate PRs on the suite (and what to do when
  Playwright is flaky during a deploy).
- Deploy-preview URLs so each PR runs against an isolated build.

Those are operational decisions outside the scope of the audit;
file a separate task when the team is ready to invest.

## Suggested next tests

In rough priority order, before this suite is "real":

1. Storefront → cart → mock-Stripe checkout success page.
2. Auth: sign-up + email verification + sign-in.
3. Account dashboard subscription view.
4. Admin sign-in + system-info page (gated by `useGetAdminMe`).
5. Order placement with insurance lead path.
