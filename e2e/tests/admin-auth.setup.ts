// Playwright auth setup — signs into the admin console once and saves
// the authenticated storage state for the `admin` project to reuse.
//
// Runs only in the backend-backed e2e job (the `admin` project is added
// to playwright.config.ts only when E2E_ADMIN is set). It performs a
// REAL sign-in through the SPA form against the live API + PostgREST
// stack, so it exercises the same cookie/session path a staff user
// hits. Credentials come from the env (the CI job seeds the matching
// admin via `auth:set-admin-password`).

import { test as setup, expect } from "@playwright/test";

import { ADMIN_STORAGE_STATE } from "./admin/storage-state";

const EMAIL = process.env["E2E_ADMIN_EMAIL"] ?? "e2e-admin@example.com";
const PASSWORD = process.env["E2E_ADMIN_PASSWORD"] ?? "";

setup("authenticate as admin", async ({ page }) => {
  expect(
    PASSWORD,
    "E2E_ADMIN_PASSWORD must be set for the admin e2e project",
  ).not.toBe("");

  await page.goto("/admin/sign-in", { waitUntil: "domcontentloaded" });

  // The sign-in form (artifacts/cpap-fitter/src/pages/admin/sign-in.tsx)
  // has a single email + password input and a "Sign in" submit.
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  // A successful sign-in redirects off /admin/sign-in to the console.
  await expect(page).toHaveURL(/\/admin(?!\/sign-in)/, { timeout: 15_000 });

  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
});
