// Resolve which tenant an inbound Slack request belongs to.
//
// Inbound Slack webhooks (interactivity + slash commands) carry a workspace
// `team_id` but no orgId. In a multi-tenant deployment each tenant connects
// its OWN Slack app, so we map the team_id → orgId by the tenant's stored
// `SLACK_TEAM_ID` app_config value, then verify the request with THAT
// tenant's signing secret and act in THAT tenant's scope.
//
// This is a tenant-DIRECTORY lookup (we're deciding which org), so it must
// query app_config across ALL orgs — via the `.raw()` escape hatch on the
// org-scoped facade (which would otherwise pin a single org_id filter).
// Fail-soft: any error/no-match returns null and the caller falls back to the
// seed org (single-tenant back-compat).

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../logger";

/**
 * The orgId whose tenant has registered `slackTeamId` as its Slack workspace,
 * or null when none has (caller falls back to the seed org). Never throws.
 */
export async function resolveOrgIdBySlackTeamId(
  slackTeamId: string,
): Promise<string | null> {
  if (!slackTeamId) return null;
  try {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) return null;
    // `.raw()` bypasses the per-org filter so we can search every tenant's
    // app_config rows for the one that registered this workspace id.
    const supabase = getOrgScopedClient(seedOrgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("app_config")
      .select("org_id")
      .eq("key", "SLACK_TEAM_ID")
      .eq("value", slackTeamId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const orgId = (data as { org_id?: string } | null)?.org_id;
    return typeof orgId === "string" ? orgId : null;
  } catch (err) {
    logger.warn(
      {
        event: "slack_team_resolve_failed",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "slack: team_id → org lookup failed; falling back to seed org",
    );
    return null;
  }
}
