// Smoke test: the cpap-fitter SPA renders its landing page.
//
// Purpose: prove the dev/preview build is reachable end-to-end and
// the React app mounts without runtime errors. Anything more
// ambitious (auth flow, checkout flow, admin login) is a separate
// PR — this one exists so the next test author has a working
// scaffold to copy from.

import { expect, test } from "@playwright/test";

test("storefront landing page renders without console errors", async ({
  page,
}) => {
  /** @type {string[]} */
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(err.message);
  });

  await page.goto("/", { waitUntil: "networkidle" });

  // The Home component (artifacts/cpap-fitter/src/pages/home.tsx)
  // sets the <title> tag via useDocumentTitle("") and renders the
  // marketing hero. We only assert the React tree mounted by
  // looking for one of the always-present nav anchors; deeper
  // structural assertions belong in a more specific test.
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("link", { name: /sign in/i }).first(),
  ).toBeVisible({ timeout: 10_000 });

  expect(
    consoleErrors,
    "Storefront landing page emitted browser-console errors:\n" +
      consoleErrors.join("\n"),
  ).toHaveLength(0);
});
