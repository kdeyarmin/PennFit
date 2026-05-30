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

export const authClient = createAuthClient({
  basePath: "/api/auth",
});

// Namespaced session cache key. The admin console (`lib/admin/auth-hooks`)
// shares this SPA's single QueryClient but probes a DIFFERENT endpoint
// (`/resupply-api/auth/me`). Without distinct keys the two `/me` queries
// collide: an admin sign-in would surface as the storefront customer, and
// vice-versa. Keep this distinct from `lib/admin/auth-hooks`'s key.
// Exported so the identity shim invalidates the right cache entry.
export const SESSION_QUERY_KEY = ["auth", "me", "storefront"] as const;

export const authHooks = createAuthHooks(authClient, {
  sessionQueryKey: SESSION_QUERY_KEY,
});
