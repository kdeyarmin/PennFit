// Accessibility regression test (P3.2). Loads each major public
// SPA route, runs axe-core against the rendered DOM, and fails the
// suite if axe reports any serious or critical violations.
//
// Why public routes only: signed-in / admin pages need a session
// cookie to render. The login flow has its own e2e harness and the
// admin surface is gated by env-allowlist, so wiring authenticated
// paths into a CI a11y scan is a separate, larger piece of work.
// What we lock in here is "the marketing + storefront entry points
// don't regress". Authenticated-page coverage lands as a follow-up.
//
// The severity gate (fail on serious/critical only) lives in the shared
// expectNoSeriousAxeViolations helper, reused by the fitter-funnel and
// admin a11y specs.

import { test } from "@playwright/test";

import { expectNoSeriousAxeViolations } from "./axe.helper";

const PUBLIC_ROUTES: ReadonlyArray<{ path: string; label: string }> = [
  { path: "/", label: "home" },
  { path: "/shop", label: "shop" },
  // /consent is now invitation-gated (it redirects to /fitter-invite
  // without an invite token), so scan the public invitation-required
  // landing instead — that's the entry point an uninvited visitor sees.
  { path: "/fitter-invite", label: "fitter invite" },
  { path: "/contact", label: "contact" },
  { path: "/admin/sign-in", label: "admin sign-in" },
  // Customer auth forms — directly reachable, and the entry points where
  // a shopper types credentials, so their inline field errors must stay
  // accessible.
  { path: "/sign-in", label: "customer sign-in" },
  { path: "/sign-up", label: "customer sign-up" },
  { path: "/forgot-password", label: "forgot password" },
];

for (const { path, label } of PUBLIC_ROUTES) {
  test(`${label} (${path}) has no serious/critical axe violations`, async ({
    page,
  }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await expectNoSeriousAxeViolations(page, `${label} (${path})`);
  });
}
