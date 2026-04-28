import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

// Penn Resupply Operator Console entry point.
//
// Two providers wrap the app, in this exact order:
//
//   1. ClerkProvider — owns the auth session. Must wrap everything
//      that calls `useAuth()` / `useUser()` (including the API auth
//      bridge inside <App />). The publishable key is read from a
//      Vite env var so the same bundle works in dev (Replit Secret)
//      and prod (build-time injection).
//
//   2. QueryClientProvider — owns the react-query cache used by the
//      generated resupply API client. Inside ClerkProvider so that
//      React Query hooks can pull a session token via the auth
//      bridge before issuing requests.
//
// Why this fails-loud instead of soft-defaulting: a missing
// publishable key would render an apparently-working sign-in form
// that silently rejects every credential. Throwing at boot turns a
// confusing UX bug into an obvious "VITE_CLERK_PUBLISHABLE_KEY
// missing" log line.

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

if (!CLERK_PUBLISHABLE_KEY) {
  throw new Error(
    "VITE_CLERK_PUBLISHABLE_KEY is required for the resupply dashboard — " +
      "set it in Replit Secrets.",
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache /me for a minute so quick tab switches don't hammer the
      // API. We deliberately disable refetchOnWindowFocus: every focus
      // refetch of /me runs requireOperator, which today calls
      // clerkClient.users.getUser per request — a Clerk Backend API
      // round-trip we don't want to pay on every tab return. The
      // operator's session validity is already enforced by Clerk
      // itself; on token expiry the next API call (or page nav) will
      // fail closed and re-route through sign-in.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, err: unknown) => {
        const status =
          (err as { status?: number } | null | undefined)?.status ?? 0;

        // 401 ONLY: retry exactly once. There is a narrow race where
        // the very first /me request can ship without a Bearer token
        // — Clerk rotates the session token roughly every minute and
        // the SDK's `getToken()` returns null mid-rotation. Without
        // this single retry, that blip routes a perfectly-valid
        // operator to the "Not authorized" screen and the only fix
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

createRoot(document.getElementById("root")!).render(
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ClerkProvider>,
);
