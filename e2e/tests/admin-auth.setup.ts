// Playwright auth setup — signs into the admin console once and saves
// the authenticated storage state for the `admin` project to reuse.
//
// Runs only in the backend-backed e2e job (the `admin` project is added
// to playwright.config.ts only when E2E_ADMIN is set). It performs a
// REAL sign-in through the SPA form against the live API + PostgREST
// stack, so it exercises the same cookie/session path a staff user
// hits. Credentials come from the env (the CI job seeds the matching
// admin via `auth:set-admin-password`).
//
// Robustness notes (this setup gates the whole admin project, so a
// flaky sign-in fails every downstream spec):
//   * We wait for the bundle to settle (`networkidle`) and for the
//     form control to be editable before typing, so we never interact
//     with a half-mounted SPA.
//   * We await the actual `POST …/auth/sign-in` response and assert it
//     succeeded BEFORE waiting on the redirect. This absorbs cold-start
//     latency (the API's first DB/PostgREST round-trip after boot can
//     be slow even though `/healthz` — liveness only — is already green)
//     and, when something is genuinely wrong, pins the failure to the
//     API call (status + body) instead of a bare "URL never changed".
//   * If the redirect still doesn't happen, we surface the on-screen
//     error banner so the failure says *why* (bad creds / locked / MFA)
//     rather than just timing out.

import { test as setup, expect } from "@playwright/test";

import { ADMIN_STORAGE_STATE } from "./admin/storage-state";

const EMAIL = process.env["E2E_ADMIN_EMAIL"] ?? "e2e-admin@example.com";
const PASSWORD = process.env["E2E_ADMIN_PASSWORD"] ?? "";

setup("authenticate as admin", async ({ page }) => {
  expect(
    PASSWORD,
    "E2E_ADMIN_PASSWORD must be set for the admin e2e project",
  ).not.toBe("");

  // `networkidle` (not `domcontentloaded`) so the SPA bundle has loaded
  // and React has mounted the form before we touch it.
  await page.goto("/admin/sign-in", { waitUntil: "networkidle" });

  // The sign-in form (artifacts/cpap-fitter/src/pages/admin/sign-in.tsx)
  // has a single email + password input and a "Sign in" submit.
  const emailInput = page.locator('input[type="email"]');
  const passwordInput = page.locator('input[type="password"]');
  const submit = page.getByRole("button", { name: /sign in/i });

  await expect(emailInput).toBeEditable();
  await emailInput.fill(EMAIL);
  await passwordInput.fill(PASSWORD);
  // Confirm React captured the controlled-input values before we submit
  // — guards against typing into a control that isn't wired up yet.
  await expect(emailInput).toHaveValue(EMAIL);
  await expect(passwordInput).toHaveValue(PASSWORD);

  // Arm the response wait BEFORE clicking so we can't miss it.
  const signInResponse = page.waitForResponse(
    (r) =>
      // Exact path so we don't match `/auth/sign-in/verify-mfa`.
      new URL(r.url()).pathname === "/resupply-api/auth/sign-in" &&
      r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await submit.click();

  const response = await signInResponse;
  if (!response.ok()) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `admin sign-in POST failed: ${response.status()} ${response.statusText()} — ${body.slice(0, 500)}`,
    );
  }

  // A successful sign-in redirects off /admin/sign-in to the console.
  // Generous timeout for a cold-start first navigation; on failure,
  // include the on-screen error banner (if any) for a useful message.
  try {
    await page.waitForURL(/\/admin(?!\/sign-in)/, { timeout: 30_000 });
  } catch (err) {
    const banner = await page
      .getByRole("alert")
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(
      `sign-in did not redirect off /admin/sign-in (url=${page.url()})` +
        (banner ? ` — on-screen error: "${banner.trim()}"` : ""),
      { cause: err },
    );
  }

  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
});
