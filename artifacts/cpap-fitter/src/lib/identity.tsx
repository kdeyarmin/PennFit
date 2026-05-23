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
      // Push subscriptions persist past localStorage clears — the
      // browser holds them in the SW registration, and the SERVER
      // keeps the endpoint→customer row bound to User A. Without
      // explicit unsubscribe, User A's PHI-bearing push notifications
      // (order delivery, billing reminders, therapy milestones) keep
      // flowing to the device that User B now uses. Unregister from
      // the push provider AND tell the server to drop the endpoint
      // BEFORE we clear local state.
      if (typeof window !== "undefined" && "serviceWorker" in navigator) {
        try {
          const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
          const sub = reg ? await reg.pushManager.getSubscription() : null;
          if (sub) {
            const endpoint = sub.endpoint;
            await sub.unsubscribe().catch(() => undefined);
            try {
              await fetch("/resupply-api/shop/me/push-subscriptions", {
                method: "DELETE",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ endpoint }),
              });
            } catch {
              // Server-side delete is best-effort during sign-out;
              // the SW unsubscribe above is what stops new pushes
              // from reaching this device.
            }
          }
        } catch {
          // SW APIs unavailable (iOS Safari pre-16.4, dev with
          // service-worker disabled, etc). Falls through to the
          // localStorage clears below.
        }
      }

      // Bypass the React Query mutation so the shim is callable
      // from non-component contexts. Components that want the
      // cache-reset side-effect on sign-out should use
      // authHooks.useSignOut() directly.
      //
      // DO NOT swallow the auth-server error here. If /api/auth/sign-out
      // 5xx'd, the server still holds a valid session cookie — the
      // user appears signed out (the SPA navigates to the signed-out
      // state), but the next /api/auth/me probe returns 200 and they
      // (or whoever uses the device next) are silently back in their
      // account. Re-throw so the caller can surface "sign-out
      // failed, please retry" and keep the session visible.
      let serverSignOutError: unknown = null;
      try {
        await authClient.signOut();
      } catch (err) {
        serverSignOutError = err;
      }
      // Clear shop-side per-device state so the next sign-in on a
      // shared device (library / clinic kiosk / family iPad) doesn't
      // inherit User A's cart, wishlist, comparator selection, or
      // recently-viewed history. The cart in particular leaks
      // intent — User B signing in shouldn't see User A's items
      // pre-loaded at checkout. Run this even if the server-side
      // sign-out failed so the device-shared content doesn't bleed.
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem("pennpaps_cart_v1");
          window.localStorage.removeItem("pennpaps:wishlist:v1");
          window.localStorage.removeItem("pennpaps:compare:v1");
          window.localStorage.removeItem("pennpaps_recently_viewed_v1");
        } catch {
          // Safari private mode etc — best-effort.
        }
      }
      if (serverSignOutError) throw serverSignOutError;
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
