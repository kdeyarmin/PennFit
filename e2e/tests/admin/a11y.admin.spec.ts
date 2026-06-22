// Accessibility sweep of the authenticated admin console — the surface
// the public a11y.spec.ts can't reach because every /admin page needs a
// session cookie to render.
//
// Runs in the `admin` Playwright project (authenticated storage state
// from admin-auth.setup.ts) against the live API + PostgREST stack, so it
// only executes under the gated `e2e-admin` job (E2E_ADMIN set). Each
// page is given a moment to mount its `.admin-root` theme container
// before axe runs, then we fail on serious/critical violations only —
// the same gate the public sweep uses.

import { test, expect } from "@playwright/test";

import { expectNoSeriousAxeViolations } from "../axe.helper";

const ADMIN_ROUTES: ReadonlyArray<{ path: string; label: string }> = [
  { path: "/admin", label: "admin console" },
  { path: "/admin/patients", label: "admin patients" },
  { path: "/admin/operations", label: "admin operations" },
];

for (const { path, label } of ADMIN_ROUTES) {
  test(`${label} (${path}) has no serious/critical axe violations`, async ({
    page,
  }) => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    // A valid session must NOT bounce us to sign-in.
    await expect(page).not.toHaveURL(/\/admin\/sign-in/, { timeout: 15_000 });
    // The admin shell wraps its surfaces in `.admin-root`; wait for it so
    // axe scans the rendered console, not a loading shell.
    await expect(page.locator(".admin-root").first()).toBeVisible({
      timeout: 15_000,
    });

    await expectNoSeriousAxeViolations(page, `${label} (${path})`);
  });
}
