// Stage 5c — Clerk JWT bridge retired. The generated resupply
// API client's bearer-token getter is now a permanent no-op:
// the dashboard authenticates via the `pf_session` cookie set
// by /resupply-api/auth/sign-in, which the browser sends
// automatically on every same-origin (and credentialed cross-
// origin) request.
//
// `useApiAuthBridge()` is kept on the public surface as a
// no-op hook so App.tsx's existing call site compiles. New code
// should not call it; remove on the next sweep.

import { setAuthTokenGetter } from "@workspace/resupply-api-client";

// Register a getter that always returns null. The custom-fetch
// layer in `@workspace/resupply-api-client` treats null as
// "no Authorization header" — exactly what we want, because
// auth now travels in the cookie.
setAuthTokenGetter(async () => null);

/** No-op kept for back-compat with App.tsx. */
export function useApiAuthBridge(): void {
  // Intentionally empty.
}
