// Dashboard identity shim. Stage 5a retired the kill switch;
// Stage 5c retired the Clerk implementation. The hook now reads
// from the in-house /resupply-api/auth/me probe via the React
// Query hook from @workspace/resupply-auth-react.
//
// Components that previously called `useUser()` / `useClerk()`
// import `useDashboardIdentity` from here instead. The
// `IS_IN_HOUSE_AUTH` constant is preserved at `true` for
// back-compat with any leftover branches; new code should not
// branch on it.

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

/**
 * @deprecated Always true after Stage 5c. Kept on the surface so
 * existing call sites compile; remove on the next sweep.
 */
export const IS_IN_HOUSE_AUTH = true;
