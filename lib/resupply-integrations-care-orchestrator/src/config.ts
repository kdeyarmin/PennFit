// Care Orchestrator (Philips Respironics) credentials. Same
// read-at-call-time pattern as the AirView adapter — missing env
// returns null, the adapter reports "unavailable" and serves no
// data (it never fabricates a snapshot).
//
// Required env for live mode:
//   CARE_ORCHESTRATOR_API_BASE_URL    — partner REST endpoint
//   CARE_ORCHESTRATOR_OAUTH_TOKEN_URL — OAuth2 token endpoint
//   CARE_ORCHESTRATOR_CLIENT_ID
//   CARE_ORCHESTRATOR_CLIENT_SECRET
//   CARE_ORCHESTRATOR_PARTNER_ID      — DME / partner identifier

export interface CareOrchestratorConfig {
  apiBaseUrl: string;
  oauthTokenUrl: string;
  clientId: string;
  clientSecret: string;
  partnerId: string;
}

export function readCareOrchestratorConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): CareOrchestratorConfig | null {
  const apiBaseUrl = env.CARE_ORCHESTRATOR_API_BASE_URL?.replace(/\/$/, "");
  const oauthTokenUrl = env.CARE_ORCHESTRATOR_OAUTH_TOKEN_URL;
  const clientId = env.CARE_ORCHESTRATOR_CLIENT_ID;
  const clientSecret = env.CARE_ORCHESTRATOR_CLIENT_SECRET;
  const partnerId = env.CARE_ORCHESTRATOR_PARTNER_ID;
  if (!apiBaseUrl || !oauthTokenUrl || !clientId || !clientSecret || !partnerId) {
    return null;
  }
  return { apiBaseUrl, oauthTokenUrl, clientId, clientSecret, partnerId };
}
