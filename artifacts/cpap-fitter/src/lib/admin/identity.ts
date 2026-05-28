// Dashboard identity shim. Reads the current session from
// /resupply-api/auth/me via the React Query hook from
// @workspace/resupply-auth-react.
//
// Use `useDashboardIdentity()` to read the current admin/agent's
// session state.

import { useQueryClient } from "@tanstack/react-query";

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
  const queryClient = useQueryClient();
  return {
    email: data?.email ?? null,
    role: data?.role ?? null,
    displayName: data?.displayName ?? null,
    userId: data?.id ?? null,
    signOut: async () => {
      // Bypass the React Query mutation so the shim is callable
      // from non-component contexts (e.g. an error boundary).
      //
      // DO NOT swallow the auth-server error. A failed /sign-out
      // leaves the server-side session cookie valid; the UI flips
      // to the signed-out state but the next /resupply-api/me
      // succeeds and the admin is silently back in their account
      // (much worse than the patient case — admin tokens unlock
      // PHI). Re-throw so the caller surfaces a retry prompt.
      await authClient.signOut();
      // Invalidate cached identity queries so AppShell stops
      // rendering with the prior role/email. Without this, sign-out
      // + sign-in as a demoted user (admin → agent) would render
      // admin-only nav tiles for up to staleTime because
      // useGetAdminMe served the cached prior role.
      try {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["/resupply-api/me"],
          }),
          queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
        ]);
      } catch {
        /* best-effort */
      }
    },
  };
}
