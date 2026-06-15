// forEachActiveOrg — the multi-tenant fan-out primitive for worker crons.
//
// A recurring cron has no request context, so before the tenancy work it
// resolved a single org (`resolveSeedOrgId()`) and swept only that tenant.
// In a multi-tenant deployment a sweep must run for EVERY active tenant.
// This helper turns the one-tenant body into an all-tenant one with a
// single wrapper:
//
//   await forEachActiveOrg(async (orgId) => {
//     const db = getOrgScopedClient(orgId);
//     // …the exact per-tenant sweep that used to run for the seed org…
//   });
//
// IMPORTANT — which jobs use this:
//   * TENANT-SCOPED sweeps (reminders, billing/claims, outreach, therapy
//     snapshots, …) — YES. They read/write `resupply` tables carrying
//     `org_id`, so they must run once per tenant.
//   * GLOBAL-table sweeps (idempotency_keys / worker_dedup_keys prune,
//     object-storage ACL sweep) — NO. Those tables have no `org_id` and
//     are reached via `.raw()`; they run ONCE across all tenants and
//     should keep resolving a single org just to build a client.
//
// Error isolation: one tenant's failure must not abort the others. Each
// org runs in its own try/catch; failures are logged and tallied, and the
// helper resolves (never rejects) with a per-tenant summary so a single
// bad tenant can't crash a shared scheduler tick.

import { listActiveOrgIds } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

export interface ForEachActiveOrgResult {
  /** Active tenants discovered this tick. */
  total: number;
  /** Tenants whose handler completed without throwing. */
  succeeded: number;
  /** Tenant ids whose handler threw (already logged). */
  failedOrgIds: string[];
}

/**
 * Run `handler(orgId)` once for every ACTIVE tenant, isolating failures
 * per tenant. Resolves with a summary; never rejects.
 *
 * @param handler  the per-tenant sweep body
 * @param opts.jobName  label for the per-tenant failure log line
 * @param opts.listOrgIds  test seam (defaults to `listActiveOrgIds`)
 */
export async function forEachActiveOrg(
  handler: (orgId: string) => Promise<void>,
  opts: {
    jobName?: string;
    listOrgIds?: () => Promise<string[]>;
  } = {},
): Promise<ForEachActiveOrgResult> {
  const jobName = opts.jobName ?? "worker.cron";
  const listOrgIds = opts.listOrgIds ?? listActiveOrgIds;

  const orgIds = await listOrgIds();
  if (orgIds.length === 0) {
    logger.info(
      { event: "worker.fan_out.no_active_orgs", job: jobName },
      `${jobName}: no active tenants resolved — skipping tick`,
    );
    return { total: 0, succeeded: 0, failedOrgIds: [] };
  }

  const failedOrgIds: string[] = [];
  for (const orgId of orgIds) {
    try {
      await handler(orgId);
    } catch (err) {
      failedOrgIds.push(orgId);
      logger.error(
        {
          event: "worker.fan_out.tenant_failed",
          job: jobName,
          org_id: orgId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        `${jobName}: sweep failed for one tenant — continuing with the rest`,
      );
    }
  }

  return {
    total: orgIds.length,
    succeeded: orgIds.length - failedOrgIds.length,
    failedOrgIds,
  };
}
