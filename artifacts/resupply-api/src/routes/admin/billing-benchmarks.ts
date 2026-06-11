// /admin/billing/benchmarks — internal cohort benchmarks.
//
// Phase 1 (this commit): compute distribution statistics from our
// own historical claim data and surface p25/p50/p75/p90/p99 plus
// the current point estimate. CSRs see "your DSO is 31 days; the
// portfolio's p75 is 28 days — you're slightly above the mark."
//
// Phase 2 (out of scope here): purchase + ingest LexisNexis
// MarketView / VGM benchmark data for true national comparisons.
// The endpoint shape is forward-compatible.
//
// Read-only; pure aggregations; no PHI in the response.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/billing/benchmarks",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    // Pull last-180-day decided claims as the population for the
    // distribution stats. The decided population gives stable history
    // without overweighting in-flight noise.
    const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
    const { data: claims, error: claimsErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, payer_name, status, total_billed_cents, total_paid_cents, submitted_at, decision_at, paid_at, predicted_denial_probability",
      )
      .gte("decision_at", cutoff)
      .in("status", ["paid", "denied", "closed", "appealed"])
      .limit(20000);
    // Throw — a swallowed error rendered the benchmarks as all-zero
    // (same swallowed-`error` class as billing-dashboard).
    if (claimsErr) throw claimsErr;
    const claimList = claims ?? [];

    // ── DSO (days from submit → paid). ────────────────────────────
    const dsoDays = claimList
      .filter((c) => c.status === "paid" && c.submitted_at && c.paid_at)
      .map((c) => {
        const s = new Date(c.submitted_at!).getTime();
        const p = new Date(c.paid_at!).getTime();
        return Number.isFinite(s) && Number.isFinite(p)
          ? (p - s) / (24 * 3600 * 1000)
          : null;
      })
      .filter((d): d is number => d !== null && d >= 0);

    // ── First-pass denial rate. ───────────────────────────────────
    const decisions = claimList.length;
    const denials = claimList.filter(
      (c) => c.status === "denied" || c.status === "appealed",
    ).length;
    const denialRate = decisions > 0 ? denials / decisions : null;

    // ── Average paid / billed ratio. ──────────────────────────────
    const ratios = claimList
      .filter((c) => c.status === "paid" && c.total_billed_cents > 0)
      .map((c) => c.total_paid_cents / c.total_billed_cents)
      .filter((r) => Number.isFinite(r) && r >= 0 && r <= 1);
    const meanPaidRatio = ratios.length
      ? ratios.reduce((s, r) => s + r, 0) / ratios.length
      : null;

    // ── Heuristic scorer calibration: at the 0.5 threshold, what
    //    fraction actually denied? Surfaces the model's lift.
    const scoredAndDecided = claimList.filter(
      (c) => c.predicted_denial_probability !== null,
    );
    const overHalf = scoredAndDecided.filter(
      (c) => (c.predicted_denial_probability ?? 0) >= 0.5,
    );
    const overHalfDenied = overHalf.filter(
      (c) => c.status === "denied" || c.status === "appealed",
    ).length;
    const overHalfCount = overHalf.length;
    const overHalfDenialRate =
      overHalfCount > 0 ? overHalfDenied / overHalfCount : null;

    // Per-payer denial rate (top-10 by claim volume).
    const perPayer = new Map<string, { decisions: number; denials: number }>();
    for (const c of claimList) {
      const cur = perPayer.get(c.payer_name) ?? { decisions: 0, denials: 0 };
      cur.decisions++;
      if (c.status === "denied" || c.status === "appealed") cur.denials++;
      perPayer.set(c.payer_name, cur);
    }
    const perPayerRows = [...perPayer.entries()]
      .map(([payer, agg]) => ({
        payerName: payer,
        decisions: agg.decisions,
        denials: agg.denials,
        denialRate: agg.decisions > 0 ? agg.denials / agg.decisions : null,
      }))
      .sort((a, b) => b.decisions - a.decisions)
      .slice(0, 10);

    res.json({
      dsoDays: {
        population: dsoDays.length,
        percentiles: percentiles(dsoDays, [25, 50, 75, 90, 99]),
        mean: dsoDays.length
          ? dsoDays.reduce((s, n) => s + n, 0) / dsoDays.length
          : null,
      },
      denialRate: {
        population: decisions,
        overall: denialRate,
      },
      paidRatio: {
        population: ratios.length,
        meanFraction: meanPaidRatio,
      },
      heuristicScorerLift: {
        claimsScored: scoredAndDecided.length,
        overHalfCount,
        overHalfDeniedActual: overHalfDenied,
        overHalfDenialRate,
        // Reference: overall denial rate; the scorer is useful when
        // overHalfDenialRate >> denialRate.
      },
      topPayersByVolume: perPayerRows,
      note:
        "Phase 1: cohort = our own decided claims in the last 180 days. " +
        "National benchmark licensing (LexisNexis MarketView / VGM) is " +
        "Phase 2; the response shape will gain national.* fields without " +
        "breaking the current keys.",
      generatedAt: new Date().toISOString(),
    });
  },
);

function percentiles(
  values: number[],
  ps: number[],
): Record<number, number | null> {
  if (values.length === 0) {
    return Object.fromEntries(ps.map((p) => [p, null]));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const out: Record<number, number | null> = {};
  for (const p of ps) {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const frac = idx - lo;
    out[p] = sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
  }
  return out;
}

export default router;
