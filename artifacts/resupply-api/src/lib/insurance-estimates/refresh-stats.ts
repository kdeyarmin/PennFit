// Recompute the learned per-payer OOP stats from adjudicated claims and
// replace the payer_estimate_stats table (owner #O2). Called by the
// weekly worker; kept here (not in the job file) so it's importable +
// mockable by the job's registration test.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { summarizeOopBySlug } from "./learn";

/** Trailing window of claims to learn from. */
export const PAYER_STATS_WINDOW_DAYS = 365;
/** A slug needs at least this many classified claims to publish a stat. */
export const PAYER_STATS_MIN_SAMPLE = 10;

export interface RefreshStatsResult {
  slugsWritten: number;
  samplesScanned: number;
}

export async function refreshPayerEstimateStats(): Promise<RefreshStatsResult> {
  const supabase = getSupabaseServiceRoleClient();
  const cutoff = new Date(
    Date.now() - PAYER_STATS_WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  // One row per adjudicated claim: { payer_name, oop_cents }.
  const { data, error } = await supabase
    .schema("resupply")
    .rpc("payer_oop_samples", { p_cutoff: cutoff });
  if (error) throw error;
  const samples = (
    (data ?? []) as Array<{ payer_name: string; oop_cents: number | string }>
  ).map((r) => ({
    payerName: String(r.payer_name),
    oopCents: Number(r.oop_cents),
  }));

  const stats = summarizeOopBySlug(samples, PAYER_STATS_MIN_SAMPLE);

  // Replace the table contents. PostgREST requires a filter on delete;
  // slug is never empty, so neq '' matches every row.
  const { error: delErr } = await supabase
    .schema("resupply")
    .from("payer_estimate_stats")
    .delete()
    .neq("slug", "");
  if (delErr) throw delErr;

  if (stats.length > 0) {
    const computedAt = new Date().toISOString();
    const { error: insErr } = await supabase
      .schema("resupply")
      .from("payer_estimate_stats")
      .insert(
        stats.map((s) => ({
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
