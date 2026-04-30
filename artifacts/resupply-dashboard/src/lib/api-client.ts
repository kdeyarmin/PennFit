import { useEffect } from "react";
import { useAuth } from "@clerk/react";
import { setAuthTokenGetter } from "@workspace/resupply-api-client";

// Bridge between the session-token API and the generated resupply
// API client's `setAuthTokenGetter` hook.
//
// The generated client (orval + react-query) reads the bearer token
// via a module-level getter we register at app startup. Clerk's token
// is short-lived (≈1 min) and rotated by the SDK, so we MUST call
// `getToken()` on every request — caching the token here would race
// the rotation and produce occasional 401s after the page has been
// open for a while.
//
// Two registrations, on purpose:
//
//   1. A module-level register on import (`registerGlobalGetter()`
//      below) reads the session token off `window.Clerk.session`.
//      `@clerk/clerk-js` installs `window.Clerk` once <ClerkProvider>
//      mounts, before any of our React queries fire. Registering at
//      module load guarantees the very first API call has a token
//      source — if we waited for `useEffect` inside `useApiAuthBridge`,
//      a query that fires during the same render commit (e.g. a
//      gated `useGetAdminMe`) would issue WITHOUT a token because
//      effects run after children render.
//
//   2. `useApiAuthBridge` re-registers the getter against Clerk's
//      `useAuth().getToken` on every session change (sign-in, sign-
//      out, switch account). Behaviorally equivalent to the global
//      getter once the auth provider has loaded, but this keeps the bridge in
//      lockstep with React state for any future API surface change.
//
// On sign-out, both getters resolve to null, which the custom-fetch
// layer treats as "no Authorization header" — the API then returns
// 401 and the dashboard's gate falls back to the sign-in screen.

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function getTokenFromGlobal(): Promise<string | null> {
  // `globalThis.Clerk` is set by `@clerk/clerk-js` once the provider
  // mounts; before that point it's undefined and the getter returns
  // null (the request goes out unauthenticated and the API returns
  // 401, which the gate handles).
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return null;
  try {
    return await clerk.session.getToken();
  } catch {
    return null;
  }
}

// Register synchronously at module load. This file is imported by
// App.tsx via `useApiAuthBridge`, so the getter is wired before the
// React tree starts mounting.
setAuthTokenGetter(getTokenFromGlobal);

export function useApiAuthBridge(): void {
  const { getToken } = useAuth();
  useEffect(() => {
    setAuthTokenGetter(async () => {
      try {
        return await getToken();
      } catch {
        // Defensive: if the auth provider throws (e.g. network blip during token
        // refresh), suppress the error so the API client still issues
        // the request — without a token, it'll get a clean 401 and
        // the gate handles it. Throwing here would crash the request
        // chain with an opaque "auth getter failed" error.
        return null;
      }
    });
    // No cleanup that resets to null on unmount: the dashboard
    // re-mounts on every navigation and we don't want a flicker
    // window where requests go unauthenticated. The global getter
    // remains as a safety net.
  }, [getToken]);
}
