// In-house auth wiring for the cpap-fitter SPA.
//
// Constructed once at module load:
//   * `authClient` — fetch wrapper bound to /api/auth (the path
//     api-server mounts the in-house router at).
//   * `authHooks` — React Query hooks (useSession, useSignIn, …).
//
// Imported by:
//   * `lib/identity.tsx` — the shared identity hook surface.
//   * The in-house sign-in / sign-up / forgot / reset / verify pages.

import {
  createAuthClient,
  createAuthHooks,
} from "@workspace/resupply-auth-react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
});

export const authHooks = createAuthHooks(authClient);
