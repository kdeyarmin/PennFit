// In-house auth wiring for the cpap-fitter SPA.
//
// Constructed once at module load:
//   * `authClient` — fetch wrapper bound to /api/auth (the path
//     api-server mounts the in-house router at).
//   * `authHooks` — React Query hooks (useSession, useSignIn, …).
//
// Imported by:
//   * `lib/identity.ts` — the identity shim that exposes session
//     state to the rest of the SPA.
//   * The in-house sign-in / sign-up / forgot / reset / verify
//     pages.

import {
  createAuthClient,
  createAuthHooks,
} from "@workspace/resupply-auth-react";

/**
 * Namespaced session cache key for the STOREFRONT surface. Distinct
 * from the admin key (["auth","me","admin"]) so both surfaces can
 * share one QueryClient without their session entries colliding.
 */
export const SESSION_QUERY_KEY = ["auth", "me", "storefront"] as const;

export const authClient = createAuthClient({
  basePath: "/api/auth",
});

export const authHooks = createAuthHooks(authClient, {
  sessionQueryKey: SESSION_QUERY_KEY,
});
