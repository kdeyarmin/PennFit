// Auth + session handlers. In demo mode the storefront is auto-signed
// in as a demo customer and the admin console as a demo admin, so the
// account area and /admin/* are explorable without real credentials.
//
// Both surfaces use the same in-house auth client (lib/resupply-auth-
// react) on different base paths: /api/auth (storefront) and
// /resupply-api/auth (admin). `fetchMe()` GETs `<base>/me`.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { DEMO_CUSTOMER } from "../fixtures/account";
import { DEMO_ADMIN_AUTH } from "../fixtures/admin";

const ok = () => json({ ok: true });

function authMutations(base: string): DemoHandler[] {
  return [
    route("GET", `${base}/csrf`, () => json({ ok: true })),
    route("POST", `${base}/sign-in`, () => json({ ok: true })),
    route("POST", `${base}/sign-in/verify-mfa`, () => ok()),
    route("POST", `${base}/sign-up`, () => ok()),
    route("POST", `${base}/sign-out`, () => ok()),
    route("POST", `${base}/forgot-password`, () => ok()),
    route("POST", `${base}/reset-password`, () => ok()),
    route("POST", `${base}/verify-email`, () => ok()),
    route("POST", `${base}/change-password`, () => ok()),
  ];
}

export const authHandlers: DemoHandler[] = [
  // Storefront session — a signed-in demo customer.
  route("GET", "/api/auth/me", () =>
    json({
      id: DEMO_CUSTOMER.id,
      email: DEMO_CUSTOMER.email,
      role: DEMO_CUSTOMER.role,
      displayName: DEMO_CUSTOMER.displayName,
      emailVerified: DEMO_CUSTOMER.emailVerified,
      mustChangePassword: DEMO_CUSTOMER.mustChangePassword,
    }),
  ),
  ...authMutations("/api/auth"),

  // Admin session — a signed-in demo admin.
  route("GET", "/resupply-api/auth/me", () =>
    json({
      id: DEMO_ADMIN_AUTH.id,
      email: DEMO_ADMIN_AUTH.email,
      role: DEMO_ADMIN_AUTH.role,
      displayName: DEMO_ADMIN_AUTH.displayName,
      emailVerified: DEMO_ADMIN_AUTH.emailVerified,
      mustChangePassword: DEMO_ADMIN_AUTH.mustChangePassword,
    }),
  ),
  ...authMutations("/resupply-api/auth"),
];
