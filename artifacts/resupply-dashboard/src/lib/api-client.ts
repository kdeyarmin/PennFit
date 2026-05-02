// Generated resupply API client wiring.
//
// The dashboard authenticates via the `pf_session` cookie set
// by /resupply-api/auth/sign-in, which the browser sends
// automatically on every same-origin (and credentialed cross-
// origin) request. The OpenAPI client does not need to attach
// any Authorization header, so we register a getter that always
// returns null — its custom-fetch layer treats null as "no
// Authorization header", which is exactly what we want.
//
// `useApiAuthBridge()` is kept on the public surface as a
// no-op hook so App.tsx's existing call site compiles. New code
// should not call it; remove on the next sweep.

import { setAuthTokenGetter } from "@workspace/resupply-api-client";

setAuthTokenGetter(async () => null);

/** No-op kept for back-compat with App.tsx. */
export function useApiAuthBridge(): void {
  // Intentionally empty.
}
