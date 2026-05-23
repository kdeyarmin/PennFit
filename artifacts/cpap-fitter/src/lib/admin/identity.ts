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
      //
      // DO NOT swallow the auth-server error. A failed /sign-out
      // leaves the server-side session cookie valid; the UI flips
      // to the signed-out state but the next /api/auth/me succeeds
      // and the admin is silently back in their account (much
      // worse than the patient case — admin tokens unlock PHI).
      // Re-throw so the caller surfaces a retry prompt.
      await authClient.signOut();
    },
  };
}
