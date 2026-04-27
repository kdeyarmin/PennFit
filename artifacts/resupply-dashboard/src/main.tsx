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
      // The /me probe is the only call so far. Refetch on focus is
      // useful for it (a returning operator should re-confirm their
      // session is still valid) but cache for a minute so quick tab
      // switches don't hammer the API.
      staleTime: 60_000,
      retry: (failureCount, err: unknown) => {
        // Don't retry 4xx — those are deterministic auth/authorization
        // outcomes, not transient failures. Retrying a 403 on /me
        // would just thrash and make the "not authorized" screen
        // take longer to appear.
        const status =
          (err as { status?: number } | null | undefined)?.status ?? 0;
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
