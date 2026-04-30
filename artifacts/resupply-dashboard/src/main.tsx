import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { IS_IN_HOUSE_AUTH } from "./lib/identity";
import "./index.css";

// PennPaps Admin Console entry point.
//
// Provider stack depends on VITE_AUTH_PROVIDER:
//
//   * "clerk" (default) / "dual" → ClerkProvider + QueryClientProvider.
//     The dashboard SPA itself signs in through Clerk; the backend
//     accepts both Clerk JWTs and local session cookies in dual
//     mode (see ADR 014 / docs/resupply/AUTH-MIGRATION-PLAN.md).
//
//   * "in_house" → QueryClientProvider only. No ClerkProvider, so
//     none of `@clerk/react`'s hooks run; sign-in flows through
//     /resupply-api/auth/* and identity comes from the
//     useDashboardIdentity() shim.
//
// In Clerk-mode we still fail-loud on a missing publishable key:
// a missing key would render an apparently-working sign-in form
// that silently rejects every credential. Throwing at boot turns a
// confusing UX bug into an obvious env-var error.

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

if (!IS_IN_HOUSE_AUTH && !CLERK_PUBLISHABLE_KEY) {
  throw new Error(
    "VITE_CLERK_PUBLISHABLE_KEY is required for the resupply dashboard in " +
      "Clerk mode — set it in Replit Secrets, or set VITE_AUTH_PROVIDER=in_house.",
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache /me for a minute so quick tab switches don't hammer the
      // API. We deliberately disable refetchOnWindowFocus: every focus
      // refetch of /me runs requireAdmin, which today calls
      // clerkClient.users.getUser per request — a auth provider API
      // round-trip we don't want to pay on every tab return. The
      // admin's session validity is already enforced by the auth provider
      // itself; on token expiry the next API call (or page nav) will
      // fail closed and re-route through sign-in.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, err: unknown) => {
        const status =
          (err as { status?: number } | null | undefined)?.status ?? 0;

        // 401 ONLY: retry exactly once. There is a narrow race where
        // the very first /me request can ship without a Bearer token
        // — the auth provider rotates the session token roughly every minute and
        // the SDK's `getToken()` returns null mid-rotation. Without
        // this single retry, that blip routes a perfectly-valid
        // admin to the "Not authorized" screen and the only fix
        // is a manual page reload. One retry gives the SDK time to
        // refresh; if it's still 401 after that, the user really is
        // not signed in and the gate handles it.
        if (status === 401) return failureCount < 1;

        // All other 4xx — deterministic auth/authorization outcomes.
        // Retrying a 403 on /me would just thrash and make the
        // "not authorized" screen take longer to appear.
        if (status >= 400 && status < 500) return false;

        return failureCount < 2;
      },
    },
  },
});

const tree = (
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);

createRoot(document.getElementById("root")!).render(
  IS_IN_HOUSE_AUTH ? (
    tree
  ) : (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY!}>{tree}</ClerkProvider>
  ),
);
