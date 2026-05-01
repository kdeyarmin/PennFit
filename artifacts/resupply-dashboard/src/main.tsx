import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

// Resupply Admin Console entry point.
//
// The provider stack is just <QueryClientProvider> — the
// dashboard authenticates via the `pf_session` cookie set by
// /resupply-api/auth/sign-in, which the browser sends with every
// same-origin (and credentialed cross-origin) request. No
// SDK-side auth provider mounts.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache /me for a minute so quick tab switches don't hammer
      // the API. refetchOnWindowFocus stays disabled — the in-house
      // /auth/me endpoint hits a single SQL row, but a focus storm
      // from many tabs can still pile on.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, err: unknown) => {
        const status =
          (err as { status?: number } | null | undefined)?.status ?? 0;
        // 401 ONLY: retry exactly once for race conditions on
        // first paint (e.g. a sign-in cookie still being set).
        if (status === 401) return failureCount < 1;
        // All other 4xx are deterministic — don't thrash.
        if (status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
