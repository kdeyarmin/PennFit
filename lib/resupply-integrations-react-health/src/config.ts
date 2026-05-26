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

export interface ReactHealthConfig {
  apiBaseUrl: string;
  oauthTokenUrl: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
}

export function readReactHealthConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): ReactHealthConfig | null {
  const apiBaseUrl = env.REACT_HEALTH_API_BASE_URL?.replace(/\/$/, "");
  const oauthTokenUrl = env.REACT_HEALTH_OAUTH_TOKEN_URL;
  const clientId = env.REACT_HEALTH_CLIENT_ID;
  const clientSecret = env.REACT_HEALTH_CLIENT_SECRET;
  const accountId = env.REACT_HEALTH_ACCOUNT_ID;
  if (
    !apiBaseUrl ||
    !oauthTokenUrl ||
    !clientId ||
    !clientSecret ||
    !accountId
  ) {
    return null;
  }
  return { apiBaseUrl, oauthTokenUrl, clientId, clientSecret, accountId };
}
