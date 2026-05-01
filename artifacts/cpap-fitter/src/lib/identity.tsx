// Shop identity shim. Reads from the in-house /api/auth/me probe
// via the React Query hook from @workspace/resupply-auth-react.
//
// Use `useShopIdentity()` to read the current customer's identity
// state. Use `<SignedIn>` / `<SignedOut>` to render branches based
// on whether a session is present.

import type * as React from "react";

import { authClient, authHooks } from "./auth-hooks";

export interface ShopIdentity {
  email: string | null;
  userId: string | null;
  displayName: string | null;
  isSignedIn: boolean;
  isLoaded: boolean;
  signOut: () => Promise<void>;
}

export function useShopIdentity(): ShopIdentity {
  const { data, isPending } = authHooks.useSession();
  return {
    email: data?.email ?? null,
    userId: data?.id ?? null,
    displayName: data?.displayName ?? null,
    isSignedIn: Boolean(data),
    isLoaded: !isPending,
    signOut: async () => {
      // Bypass the React Query mutation so the shim is callable
      // from non-component contexts. Components that want the
      // cache-reset side-effect on sign-out should use
      // authHooks.useSignOut() directly.
      await authClient.signOut().catch(() => undefined);
    },
  };
}

export const SignedIn: React.FC<{
  children: React.ReactNode;
  fallback?: React.ReactNode;
}> = ({ children, fallback = null }) => {
  const { data, isPending } = authHooks.useSession();
  if (isPending) return <>{fallback}</>;
  if (!data) return <>{fallback}</>;
  return <>{children}</>;
};

export const SignedOut: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const { data, isPending } = authHooks.useSession();
  // Render only when we KNOW the user is signed out. While the
  // probe is pending, render nothing — avoids a flash of
  // "signed-out" UI for a user who turns out to be signed in.
  if (isPending) return null;
  if (data) return null;
  return <>{children}</>;
};

