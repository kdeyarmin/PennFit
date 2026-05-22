// Parachute Health credentials. Same read-at-call-time pattern as
// the other manufacturer-cloud adapters — missing env returns null,
// the dispatcher then logs `parachute_unconfigured` and the inbound
// webhook stays in `received` for a human to triage. The route
// (integrations-inbound.ts) still accepts the POST; only the
// dispatcher's signature-verification + mirror path is short-
// circuited.
//
// Required env for live mode:
//   PARACHUTE_SIGNING_SECRET — webhook HMAC-SHA256 secret. Issued by
//     Parachute at partner-onboarding time. Used to verify the
//     x-parachute-signature header before dispatching.
//
// Optional:
//   PARACHUTE_API_BASE_URL — REST endpoint for outbound status
//     callbacks (Phase 5). Not used in Phase 1.
//   PARACHUTE_CLIENT_ID / PARACHUTE_CLIENT_SECRET — OAuth client
//     credentials for outbound callbacks (Phase 5).
//   PARACHUTE_STUB=1 — force stub mode (no signature check; for
//     local dev only, never production).

export interface ParachuteConfig {
  signingSecret: string;
  apiBaseUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
}

/**
 * Read Parachute adapter configuration from environment variables or indicate unconfigured.
 *
 * Returns `null` when stub mode is enabled via `PARACHUTE_STUB=1` or when `PARACHUTE_SIGNING_SECRET` is missing.
 * Otherwise returns a `ParachuteConfig` with `signingSecret`, `apiBaseUrl` (trailing slash removed or `null`),
 * and optional `clientId` and `clientSecret`.
 *
 * @returns A `ParachuteConfig` populated from environment variables, or `null` if unconfigured.
 */
export function readParachuteConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): ParachuteConfig | null {
  if (env.PARACHUTE_STUB === "1") return null;
  const signingSecret = env.PARACHUTE_SIGNING_SECRET;
  if (!signingSecret) return null;
  return {
    signingSecret,
    apiBaseUrl: env.PARACHUTE_API_BASE_URL?.replace(/\/$/, "") ?? null,
    clientId: env.PARACHUTE_CLIENT_ID ?? null,
    clientSecret: env.PARACHUTE_CLIENT_SECRET ?? null,
  };
}

/**
 * Checks whether Parachute stub mode is enabled.
 *
 * @param env - Environment variables object to read `PARACHUTE_STUB` from; defaults to `process.env`
 * @returns `true` if `PARACHUTE_STUB` is set to `'1'`, `false` otherwise
 */
export function isParachuteStubMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PARACHUTE_STUB === "1";
}
