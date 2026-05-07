// Read-at-call-time AirView credentials. Mirrors the shop/Stripe
// pattern: missing env returns null, the adapter degrades to stub
// mode, the admin UI flags it as "not configured" — never crashes
// the boot sequence.
//
// Required env for live mode:
//   AIRVIEW_API_BASE_URL    — e.g. https://api.resmed.com/airview
//   AIRVIEW_OAUTH_TOKEN_URL — OAuth2 client_credentials endpoint
//   AIRVIEW_CLIENT_ID
//   AIRVIEW_CLIENT_SECRET
//   AIRVIEW_DME_ID          — partner DME identifier issued by ResMed
//
// Optional:
//   AIRVIEW_STUB=1          — force stub mode even when creds present
//                             (useful for staging / offline preview)

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
  if (env.AIRVIEW_STUB === "1") return null;
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

export function isAirviewStubMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.AIRVIEW_STUB === "1";
}
