// In-house implementation of useShopIdentity / SignedIn /
// SignedOut. Selected by `lib/identity.ts` when
// VITE_AUTH_PROVIDER === "in_house".

import type * as React from "react";

import { authHooks, authClient } from "./auth-hooks";
import type { ShopIdentity } from "./identity";

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
  // Mirror Clerk's <Show when="signed-out">: render only when we
  // KNOW the user is signed out. While the probe is pending, we
  // don't render — that avoids a flash of "signed-out" UI for a
  // user who turns out to be signed in.
  if (isPending) return null;
  if (data) return null;
  return <>{children}</>;
};
