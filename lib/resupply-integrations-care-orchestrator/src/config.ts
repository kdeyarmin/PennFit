// Care Orchestrator (Philips Respironics) credentials. Same
// read-at-call-time pattern as the AirView adapter — missing env
// returns null, adapter degrades to stub mode, admin UI flags the
// "stub" badge.
//
// Required env for live mode:
//   CARE_ORCHESTRATOR_API_BASE_URL    — partner REST endpoint
//   CARE_ORCHESTRATOR_OAUTH_TOKEN_URL — OAuth2 token endpoint
//   CARE_ORCHESTRATOR_CLIENT_ID
//   CARE_ORCHESTRATOR_CLIENT_SECRET
//   CARE_ORCHESTRATOR_PARTNER_ID      — DME / partner identifier
//
// Optional:
//   CARE_ORCHESTRATOR_STUB=1          — force stub mode

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
  if (env.CARE_ORCHESTRATOR_STUB === "1") return null;
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

export function isCareOrchestratorStubMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CARE_ORCHESTRATOR_STUB === "1";
}
