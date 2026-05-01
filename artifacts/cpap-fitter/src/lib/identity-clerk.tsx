// Clerk-backed implementation of useShopIdentity / SignedIn /
// SignedOut. Selected by `lib/identity.ts` when
// VITE_AUTH_PROVIDER !== "in_house".

import type * as React from "react";
import { Show, useClerk, useUser } from "@clerk/react";

import type { ShopIdentity } from "./identity";

export function useShopIdentity(): ShopIdentity {
  const { user, isLoaded, isSignedIn } = useUser();
  const clerk = useClerk();
  const primary =
    user?.primaryEmailAddress?.emailAddress?.toLowerCase() ??
    user?.emailAddresses?.[0]?.emailAddress?.toLowerCase() ??
    null;
  return {
    email: primary,
    userId: user?.id ?? null,
    displayName: user?.fullName ?? null,
    isSignedIn: Boolean(isSignedIn),
    isLoaded: Boolean(isLoaded),
    signOut: async () => {
      await clerk.signOut();
    },
  };
}

export const SignedIn: React.FC<{
  children: React.ReactNode;
  fallback?: React.ReactNode;
}> = ({ children, fallback = null }) => (
  <Show when="signed-in" fallback={fallback}>
    {children}
  </Show>
);

export const SignedOut: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => <Show when="signed-out">{children}</Show>;
