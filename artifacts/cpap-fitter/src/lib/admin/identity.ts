// Dashboard identity shim. Reads the current session from
// /resupply-api/auth/me via the React Query hook from
// @workspace/resupply-auth-react.
//
// Use `useDashboardIdentity()` to read the current admin/agent's
// session state.

import { authHooks, authClient } from "./auth-hooks";

export interface DashboardIdentity {
  email: string | null;
  role: "admin" | "agent" | "customer" | null;
  displayName: string | null;
  userId: string | null;
  signOut: () => Promise<void>;
}

/**
 * Read the current dashboard identity. Returns null-shaped values
 * when no session is present; callers should branch on
 * `email !== null` (or wrap with a session gate).
 */
export function useDashboardIdentity(): DashboardIdentity {
  const { data } = authHooks.useSession();
  return {
    email: data?.email ?? null,
    role: data?.role ?? null,
    displayName: data?.displayName ?? null,
    userId: data?.id ?? null,
    signOut: async () => {
      // Bypass the React Query mutation so the shim is callable
      // from non-component contexts (e.g. an error boundary).
      // Components that want the cache-reset side effect on
      // sign-out should use authHooks.useSignOut() directly.
      await authClient.signOut().catch(() => undefined);
    },
  };
}
