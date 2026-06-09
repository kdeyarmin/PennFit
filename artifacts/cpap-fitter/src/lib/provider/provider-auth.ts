// Auth wiring for the provider e-signature portal.
//
// Constructed once at module load and bound to the dedicated provider
// auth mount on the API (/api/provider/auth). Reuses the same in-house
// auth client + React Query hooks as the admin + storefront surfaces;
// only the basePath and the session cache key differ so a provider
// sign-in/out doesn't invalidate the admin or storefront session cache.

import {
  createAuthClient,
  createAuthHooks,
} from "@workspace/resupply-auth-react";

export const PROVIDER_SESSION_QUERY_KEY = ["auth", "me", "provider"] as const;

export const providerAuthClient = createAuthClient({
  basePath: "/api/provider/auth",
});

export const providerAuthHooks = createAuthHooks(providerAuthClient, {
  sessionQueryKey: PROVIDER_SESSION_QUERY_KEY,
});
