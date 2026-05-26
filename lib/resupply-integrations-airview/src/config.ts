// Read-at-call-time AirView credentials. Missing env returns null;
// the adapter then reports "unavailable" and serves no data — it
// never fabricates a snapshot and never crashes the boot sequence.
//
// Required env for live mode:
//   AIRVIEW_API_BASE_URL    — e.g. https://api.resmed.com/airview
//   AIRVIEW_OAUTH_TOKEN_URL — OAuth2 client_credentials endpoint
//   AIRVIEW_CLIENT_ID
//   AIRVIEW_CLIENT_SECRET
//   AIRVIEW_DME_ID          — partner DME identifier issued by ResMed

export interface AirviewConfig {
  apiBaseUrl: string;
  oauthTokenUrl: string;
  clientId: string;
  clientSecret: string;
  dmeId: string;
}

export function readAirviewConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): AirviewConfig | null {
  const apiBaseUrl = env.AIRVIEW_API_BASE_URL?.replace(/\/$/, "");
  const oauthTokenUrl = env.AIRVIEW_OAUTH_TOKEN_URL;
  const clientId = env.AIRVIEW_CLIENT_ID;
  const clientSecret = env.AIRVIEW_CLIENT_SECRET;
  const dmeId = env.AIRVIEW_DME_ID;
  if (!apiBaseUrl || !oauthTokenUrl || !clientId || !clientSecret || !dmeId) {
    return null;
  }
  return { apiBaseUrl, oauthTokenUrl, clientId, clientSecret, dmeId };
}
