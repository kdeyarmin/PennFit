// Storefront e2e: the home trust-signal strip renders, including the
// on-device privacy badge.
//
// Guards the marketing surface added alongside the on-device mask-fitter
// privacy guarantee ("images never leave your device"). The badge is a
// deliberate differentiator vs. server-side face-scan competitors, so a
// regression that drops it from the home page is worth catching. The
// strip self-hides only the live review-rating chip when the API is
// absent (see TrustSignalStrip) — the static promise badges, including
// privacy, always render, which is exactly why this is safe to assert in
// the backend-less smoke harness.

import { expect, test } from "@playwright/test";

test("home page surfaces the on-device privacy trust badge", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // The strip itself mounts unconditionally under the hero.
  await expect(page.getByTestId("trust-signal-strip")).toBeVisible({
    timeout: 10_000,
  });

  // The privacy badge is a static promise (data-testid="trust-privacy")
  // and must always be present, independent of the live review API.
  const privacyBadge = page.getByTestId("trust-privacy");
  await expect(privacyBadge).toBeVisible();
  await expect(privacyBadge).toContainText(/images never leave your device/i);
});
