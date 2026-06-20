// Recompute the learned per-payer OOP stats from adjudicated claims and
// replace the payer_estimate_stats table (owner #O2). Called by the
// weekly worker; kept here (not in the job file) so it's importable +
// mockable by the job's registration test.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { forEachActiveOrg } from "../../worker/lib/for-each-active-org.js";
import { summarizeOopBySlug } from "./learn";

/** Trailing window of claims to learn from. */
export const PAYER_STATS_WINDOW_DAYS = 365;
/** A slug needs at least this many classified claims to publish a stat. */
export const PAYER_STATS_MIN_SAMPLE = 10;

export interface RefreshStatsResult {
  slugsWritten: number;
  samplesScanned: number;
}

/**
 * Recompute + replace one tenant's learned payer-estimate stats. The table
 * is now keyed (org_id, slug) (migration 0382), and payer_estimate_stats is
 * learned from each tenant's OWN adjudicated claims — so the RPC takes the
 * tenant's org_id and the DELETE/INSERT are scoped to it. Returns the
 * per-tenant counts the fan-out sums.
 */
export async function refreshPayerEstimateStatsForOrg(
  orgId: string,
): Promise<RefreshStatsResult> {
  const supabase = getOrgScopedClient(orgId);
  const cutoff = new Date(
    Date.now() - PAYER_STATS_WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  // One row per adjudicated claim: { payer_name, oop_cents }. Scoped to this
  // tenant's claims (migration 0382 added p_org_id to the RPC signature).
  const { data, error } = await supabase
    .raw()
    .schema("resupply")
    .rpc("payer_oop_samples", { p_org_id: orgId, p_cutoff: cutoff });
  if (error) throw error;
  const samples = (
    (data ?? []) as Array<{ payer_name: string; oop_cents: number | string }>
  ).map((r) => ({
    payerName: String(r.payer_name),
    oopCents: Number(r.oop_cents),
  }));

  const stats = summarizeOopBySlug(samples, PAYER_STATS_MIN_SAMPLE);

  // Replace THIS tenant's rows. PostgREST requires a filter on delete; scope
  // it to the tenant's org_id (slug is never empty, so neq '' matches every
  // one of this tenant's rows).
  const { error: delErr } = await supabase
    .raw()
    .schema("resupply")
    .from("payer_estimate_stats")
    .delete()
    .eq("org_id", orgId)
    .neq("slug", "");
  if (delErr) throw delErr;

  if (stats.length > 0) {
    const computedAt = new Date().toISOString();
    const { error: insErr } = await supabase
      .raw()
      .schema("resupply")
      .from("payer_estimate_stats")
      .insert(
        stats.map((s) => ({
          org_id: orgId,
          slug: s.slug,
          p50_cents: s.p50Cents,
          p90_cents: s.p90Cents,
          sample_size: s.sampleSize,
          computed_at: computedAt,
        })),
      );
    if (insErr) throw insErr;
  }

  return { slugsWritten: stats.length, samplesScanned: samples.length };
}

export async function refreshPayerEstimateStats(): Promise<RefreshStatsResult> {
  // Fan out across every active tenant — each tenant learns from, and gets
  // its own copy of, its own claims (migration 0382), with per-tenant
  // failure isolation. Sum the per-tenant counts into the same return shape.
  let slugsWritten = 0;
  let samplesScanned = 0;
  await forEachActiveOrg(
    async (orgId) => {
      const result = await refreshPayerEstimateStatsForOrg(orgId);
      slugsWritten += result.slugsWritten;
      samplesScanned += result.samplesScanned;
    },
    { jobName: "insurance-estimate.stats-refresh" },
  );

  return { slugsWritten, samplesScanned };
}
