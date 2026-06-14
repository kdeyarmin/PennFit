// Backend-backed admin e2e: an authenticated staff session reaches the
// admin console (not bounced to sign-in).
//
// Runs in the `admin` Playwright project (authenticated storage state
// from admin-auth.setup.ts) against the live API + PostgREST stack. This
// is the dependency-free proof that the whole backend-backed harness
// works end-to-end: a seeded admin's session cookie carries through the
// real requireAdmin gate and the SPA renders the console shell.
//
// Feature-specific admin specs (e.g. the asset-recovery worklist) follow
// this same pattern — add them under e2e/tests/admin/*.admin.spec.ts on
// their feature branch and they inherit this project's auth + stack.

import { test, expect } from "@playwright/test";

test("authenticated admin reaches the console (not sign-in)", async ({
  page,
}) => {
  await page.goto("/admin", { waitUntil: "domcontentloaded" });

  // With a valid session we must NOT be redirected to the sign-in page.
  await expect(page).toHaveURL(/\/admin(?!\/sign-in)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/admin\/sign-in/);

  // The admin shell wraps its surfaces in `.admin-root` (the scoped
  // theme container every admin page mounts). Its presence proves the
  // gated console actually rendered rather than an error/redirect.
  await expect(page.locator(".admin-root").first()).toBeVisible({
    timeout: 15_000,
  });

  // The protected API is reachable with the session cookie (the SPA is
  // co-served by the same origin, so this is same-site).
  const me = await page.request.get("/resupply-api/admin/me");
  expect(me.ok()).toBeTruthy();
});
