// Auth wiring for the resupply-dashboard.
//
// Constructed once at module load:
//   * `authClient` — the fetch wrapper bound to /resupply-api/auth.
//   * `authHooks`  — React Query hooks (useSession, useSignIn, …)
//     bound to that client.
//
// Imported by:
//   * `lib/identity.ts` — the identity shim that exposes session
//     state to the rest of the SPA.
//   * The in-house sign-in / forgot / reset / verify pages.
//
// The Vite SPA serves under a base path (the artifact dir under
// the deploy URL). Auth requests, however, MUST hit the API at
// `/resupply-api/auth` — that's a SERVER path, not a client one,
// and is the same regardless of whatever base the SPA is mounted
// at. Hardcoding it here keeps the rest of the SPA from caring.

import {
  createAuthClient,
  createAuthHooks,
} from "@workspace/resupply-auth-react";

export const authClient = createAuthClient({
  basePath: "/resupply-api/auth",
});

// Namespaced session cache key. The storefront (`lib/auth-hooks`) shares
// this SPA's single QueryClient but probes a DIFFERENT endpoint
// (`/api/auth/me`). Without distinct keys the two `/me` queries collide:
// an admin sign-in would surface as the storefront customer, and
// vice-versa. Keep this distinct from `lib/auth-hooks`'s key. Exported so
// the admin identity shim invalidates the right cache entry.
export const SESSION_QUERY_KEY = ["auth", "me", "admin"] as const;

export const authHooks = createAuthHooks(authClient, {
  sessionQueryKey: SESSION_QUERY_KEY,
});
