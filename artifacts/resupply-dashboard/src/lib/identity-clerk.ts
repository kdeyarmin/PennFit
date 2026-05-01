// Clerk-backed implementation of useDashboardIdentity.
// Selected by `lib/identity.ts` when VITE_AUTH_PROVIDER !== "in_house".
//
// The shape mirrors the existing direct uses of `useUser()` /
// `useClerk()` so refactoring callers is a one-import change.

import { useClerk, useUser } from "@clerk/react";

import type { DashboardIdentity } from "./identity";

export function useDashboardIdentity(): DashboardIdentity {
  const { user } = useUser();
  const clerk = useClerk();
  const primary =
    user?.primaryEmailAddress?.emailAddress?.toLowerCase() ??
    user?.emailAddresses?.[0]?.emailAddress?.toLowerCase() ??
    null;
  return {
    email: primary,
    // Clerk doesn't tell us the resupply role directly — the
    // /admin/me probe in App.tsx is what owns that. Consumers that
    // need the role read it from /me, not from this shim.
    role: null,
    displayName: null,
    userId: user?.id ?? null,
    signOut: async () => {
      await clerk.signOut();
    },
  };
}
