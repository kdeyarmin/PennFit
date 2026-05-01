// In-house auth wiring for the resupply-dashboard.
//
// Constructed once at module load:
//   * `authClient` — the fetch wrapper bound to /resupply-api/auth.
//   * `authHooks`  — React Query hooks (useSession, useSignIn, …)
//     bound to that client.
//
// Imported by:
//   * `lib/identity.ts` — the shim that picks Clerk vs in-house
//     at app boot.
//   * The new in-house sign-in / forgot / reset / verify pages.
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

export const authHooks = createAuthHooks(authClient);
