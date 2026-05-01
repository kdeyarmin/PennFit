// In-house implementation of useDashboardIdentity. Selected by
// `lib/identity.ts` when VITE_AUTH_PROVIDER === "in_house".
//
// Reads the current session from /resupply-api/auth/me via the
// React Query hook from @workspace/resupply-auth-react.

import { authHooks, authClient } from "./auth-hooks";
import type { DashboardIdentity } from "./identity";

export function useDashboardIdentity(): DashboardIdentity {
  const { data } = authHooks.useSession();
  return {
    email: data?.email ?? null,
    role: data?.role ?? null,
    displayName: data?.displayName ?? null,
    userId: data?.id ?? null,
    signOut: async () => {
      // Bypass the React Query mutation so the shim is callable
      // from non-component contexts (e.g. an error boundary). The
      // useSignOut() hook is what /admin pages call when they want
      // the cache reset; this fallback covers everything else.
      await authClient.signOut().catch(() => undefined);
    },
  };
}
