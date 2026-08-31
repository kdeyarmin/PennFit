// Read-at-call-time React Health (3B Medical iCode Connect)
// credentials. Same posture as the AirView / Care Orchestrator
// adapters — missing env returns null, the adapter reports
// "unavailable" and serves no data (it never fabricates a
// snapshot) — never crashes the boot sequence.
//
// Required env for live mode:
//   REACT_HEALTH_API_BASE_URL    — e.g. https://api.icodeconnect.com
//   REACT_HEALTH_OAUTH_TOKEN_URL — OAuth2 client_credentials endpoint
//   REACT_HEALTH_CLIENT_ID
//   REACT_HEALTH_CLIENT_SECRET
//   REACT_HEALTH_ACCOUNT_ID      — partner DME / account identifier
//
// Optional:
//   REACT_HEALTH_RESOURCE_PATH_STYLE — "nested" (default) | "flat"

/**
 * Where the vendor hangs its patient resources.
 *
 * The iCode Connect documentation nests them under the account:
 *   /v1/account/{accountId}/patients/{partnerPatientId}/...
 *
 * This client originally called the FLAT shape,
 *   /v1/patients/{partnerPatientId}/...
 * carrying the account in an `X-Account-Id` header (mirroring AirView's
 * `X-DME-Id` pattern). Its own header said so, and said plainly that the
 * flat paths "WILL 404 against an API that implements the nested shape".
 * Since no tenant has live credentials yet, nothing had ever exercised
 * either shape against the real service.
 *
 * The default is now `nested` — the documented shape — with `flat` kept
 * as an env override so the first partner to go live can switch without
 * a deploy if their instance turns out to serve the other one. The
 * connection validator reports which shape answered.
 */
export type ReactHealthPathStyle = "nested" | "flat";

export interface ReactHealthConfig {
  apiBaseUrl: string;
  oauthTokenUrl: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
  resourcePathStyle: ReactHealthPathStyle;
}

export function readReactHealthConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): ReactHealthConfig | null {
  const apiBaseUrl = env.REACT_HEALTH_API_BASE_URL?.replace(/\/$/, "");
  const oauthTokenUrl = env.REACT_HEALTH_OAUTH_TOKEN_URL;
  const clientId = env.REACT_HEALTH_CLIENT_ID;
  const clientSecret = env.REACT_HEALTH_CLIENT_SECRET;
  const accountId = env.REACT_HEALTH_ACCOUNT_ID;
  // Anything other than an explicit "flat" is the documented nested
  // shape: an unrecognised value must not silently select the shape we
  // know is wrong.
  const resourcePathStyle: ReactHealthPathStyle =
    env.REACT_HEALTH_RESOURCE_PATH_STYLE?.trim().toLowerCase() === "flat"
      ? "flat"
      : "nested";
  if (
    !apiBaseUrl ||
    !oauthTokenUrl ||
    !clientId ||
    !clientSecret ||
    !accountId
  ) {
    return null;
  }
  return {
    apiBaseUrl,
    oauthTokenUrl,
    clientId,
    clientSecret,
    accountId,
    resourcePathStyle,
  };
}
