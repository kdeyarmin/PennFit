// /admin/billing/* — AR + reporting endpoints.
//
//   GET /admin/billing/aging-report    — claims by aging bucket
//                                        (0-30, 31-60, 61-90, 90+ days)
//                                        for non-terminal statuses.
//   GET /admin/billing/dso-by-payer    — payer-level days sales
//                                        outstanding across recent
//                                        paid claims.
//   GET /admin/billing/denial-rate     — denial rate over the last 90 days,
//                                        overall and per payer.
//
// All endpoints are read-only and surface aggregate counts /
// dollars only — no PHI in the response shapes.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type AgingBucket = "0_30" | "31_60" | "61_90" | "90_plus";

function bucketForDays(days: number): AgingBucket {
  if (days <= 30) return "0_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

router.get("/admin/billing/aging-report", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  // Pull every open claim (status not in paid/closed). The query is
  // bounded by status; for a DME book of N=10k patients we expect at
  // most a few thousand rows in flight — well under PostgREST's row
  // cap. If we outgrow that we paginate in a future change.
  const { data, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, payer_name, status, total_billed_cents, submitted_at, date_of_service")
    .not("status", "in", "(paid,closed)")
    .limit(5000);
  if (error) throw error;
  const now = Date.now();
  const buckets: Record<AgingBucket, { claimCount: number; billedCents: number }> = {
    "0_30": { claimCount: 0, billedCents: 0 },
    "31_60": { claimCount: 0, billedCents: 0 },
    "61_90": { claimCount: 0, billedCents: 0 },
    "90_plus": { claimCount: 0, billedCents: 0 },
  };
  const perPayer = new Map<
    string,
    Record<AgingBucket, { claimCount: number; billedCents: number }>
  >();
  for (const row of data ?? []) {
    const baseline = row.submitted_at ?? row.date_of_service;
    if (!baseline) continue;
    const baseMs = new Date(baseline).getTime();
    const days = Math.max(0, Math.floor((now - baseMs) / (24 * 3600 * 1000)));
    const bucket = bucketForDays(days);
    buckets[bucket].claimCount++;
    buckets[bucket].billedCents += row.total_billed_cents ?? 0;
    const payer = row.payer_name || "unknown";
    let pay = perPayer.get(payer);
    if (!pay) {
      pay = {
        "0_30": { claimCount: 0, billedCents: 0 },
        "31_60": { claimCount: 0, billedCents: 0 },
        "61_90": { claimCount: 0, billedCents: 0 },
        "90_plus": { claimCount: 0, billedCents: 0 },
      };
      perPayer.set(payer, pay);
    }
    pay[bucket].claimCount++;
    pay[bucket].billedCents += row.total_billed_cents ?? 0;
  }
  const totalOpenBilledCents = (Object.values(buckets) as { billedCents: number }[]).reduce(
    (s, b) => s + b.billedCents,
    0,
  );
  res.json({
    overall: buckets,
    perPayer: [...perPayer.entries()]
      .map(([payerName, buckets]) => ({ payerName, buckets }))
      .sort(
        (a, b) =>
          totalBilled(b.buckets) - totalBilled(a.buckets),
      ),
    totalOpenBilledCents,
    totalOpenClaimCount: (data ?? []).length,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/admin/billing/dso-by-payer", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  // DSO requires submitted_at AND paid_at. Pull the last 180 days of
  // paid claims; older data drags the metric without telling us
  // anything actionable.
  const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("payer_name, submitted_at, paid_at, total_paid_cents")
    .eq("status", "paid")
    .gte("paid_at", cutoff)
    .not("submitted_at", "is", null)
    .not("paid_at", "is", null)
    .limit(5000);
  if (error) throw error;
  const perPayer = new Map<string, { sumDays: number; sumPaidCents: number; count: number }>();
  for (const row of data ?? []) {
    if (!row.submitted_at || !row.paid_at) continue;
    const days =
      (new Date(row.paid_at).getTime() - new Date(row.submitted_at).getTime()) /
      (24 * 3600 * 1000);
    if (!Number.isFinite(days) || days < 0) continue;
    const payer = row.payer_name || "unknown";
    const cur = perPayer.get(payer) ?? { sumDays: 0, sumPaidCents: 0, count: 0 };
    cur.sumDays += days;
    cur.sumPaidCents += row.total_paid_cents ?? 0;
    cur.count += 1;
    perPayer.set(payer, cur);
  }
  const rows = [...perPayer.entries()]
    .map(([payerName, agg]) => ({
      payerName,
      claimCount: agg.count,
      totalPaidCents: agg.sumPaidCents,
      averageDaysToPay: agg.count > 0 ? agg.sumDays / agg.count : null,
    }))
    .sort((a, b) => (b.totalPaidCents ?? 0) - (a.totalPaidCents ?? 0));
  res.json({ payers: rows, windowDays: 180, generatedAt: new Date().toISOString() });
});

router.get("/admin/billing/denial-rate", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  // Per-payer decision/denial counts are aggregated server-side by the
  // resupply.billing_denial_rate RPC (migration 0164) — Postgres does
  // the GROUP BY + FILTER over the indexed insurance_claims rows and
  // returns one row per payer instead of streaming up to 10k claim
  // rows into Node for a JS reduce. A row counts as a denial when
  // status IN ('denied','appealed'); the RPC's WHERE clause already
  // restricts to decisioned statuses within the window.
  const { data, error } = await supabase
    .schema("resupply")
    .rpc("billing_denial_rate", { p_cutoff: cutoff });
  if (error) throw error;

  // PostgREST returns bigint columns as strings; coerce defensively.
  // The rpc() data generic doesn't always resolve to the Functions
  // return type through the schema-scoped client, so type the rows
  // explicitly here.
  type DenialRateRow = {
    payer_name: string;
    decisions: number | string;
    denials: number | string;
  };
  const perPayerRows = ((data ?? []) as DenialRateRow[]).map((r) => ({
    payerName: r.payer_name,
    decisions: Number(r.decisions),
    denials: Number(r.denials),
  }));
  const totals = perPayerRows.reduce(
    (acc, r) => {
      acc.decisions += r.decisions;
      acc.denials += r.denials;
      return acc;
    },
    { decisions: 0, denials: 0 },
  );
  res.json({
    overall: {
      decisions: totals.decisions,
      denials: totals.denials,
      denialRate: totals.decisions > 0 ? totals.denials / totals.decisions : null,
    },
    perPayer: perPayerRows
      .map((agg) => ({
        payerName: agg.payerName,
        decisions: agg.decisions,
        denials: agg.denials,
        denialRate: agg.decisions > 0 ? agg.denials / agg.decisions : null,
      }))
      .sort((a, b) => (b.denials ?? 0) - (a.denials ?? 0)),
    windowDays: 90,
    generatedAt: new Date().toISOString(),
  });
});

function totalBilled(
  b: Record<AgingBucket, { claimCount: number; billedCents: number }>,
): number {
  return (
    b["0_30"].billedCents +
    b["31_60"].billedCents +
    b["61_90"].billedCents +
    b["90_plus"].billedCents
  );
}

export default router;
