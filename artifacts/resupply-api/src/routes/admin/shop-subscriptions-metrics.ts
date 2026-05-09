// /admin/shop/subscriptions/metrics — KPI rollup powering the
// subscription-health dashboard.
//
// One-shot endpoint that returns every counter the dashboard needs
// in a single round-trip. The original Drizzle path leaned on
// `count(*) filter (where …)` aggregates and a `generate_series` +
// LEFT JOIN cohort table — neither of which PostgREST exposes.
//
// We fetch the small column set we need (status / created_at /
// canceled_at / cancel_at_period_end) and aggregate JS-side. Even at
// ~100x the current PennPaps subscriber count this is a fraction of
// a megabyte; the admin-only endpoint never touches a customer-
// facing latency budget.
//
// Counters returned:
//   activeNow            — status IN ('active','trialing')
//   pausedNow            — status = 'paused'
//   pastDueNow           — status IN ('past_due','unpaid')
//   canceledLifetime     — status IN ('canceled','incomplete_expired')
//   newSubsLast30d       — created_at within last 30 days
//   newSubsLast90d       — created_at within last 90 days
//   canceledLast30d      — canceled_at within last 30 days
//   canceledLast90d      — canceled_at within last 90 days
//   pendingCancellations — cancel_at_period_end = true AND active
//   churnRate30d         — canceledLast30d / (activeNow + canceledLast30d)
//
// Cohort retention: a 6-month-trailing month-over-month table of
// how many subs were created in each of the last 6 calendar months
// and how many of THAT cohort are still in a live status.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const PAST_DUE_STATUSES = new Set(["past_due", "unpaid"]);
const CANCELED_STATUSES = new Set(["canceled", "incomplete_expired"]);
const LIVE_STATUSES = new Set(["active", "trialing", "paused", "past_due"]);

router.get(
  "/admin/shop/subscriptions/metrics",
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    // Anchor every "last N days" / "last 6 months" window to the
    // same `now` so the counters are internally consistent.
    const now = new Date();
    const cutoff30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const cutoff90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Floor of the calendar month 5 months ago — i.e. the start of
    // the oldest cohort bucket.
    const cohortStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1),
    );
    const cohortStartIso = cohortStart.toISOString();

    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("shop_subscriptions")
      .select("status, created_at, canceled_at, cancel_at_period_end");
    if (error) throw error;

    let activeNow = 0;
    let pausedNow = 0;
    let pastDueNow = 0;
    let canceledLifetime = 0;
    let newSubsLast30d = 0;
    let newSubsLast90d = 0;
    let canceledLast30d = 0;
    let canceledLast90d = 0;
    let pendingCancellations = 0;
    // Map of YYYY-MM → { totalCreated, stillLive }. Pre-seed with the
    // last 6 months so the response always has 6 buckets even if a
    // month had zero new subs.
    const cohortBuckets = new Map<
      string,
      { totalCreated: number; stillLive: number }
    >();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
        2,
        "0",
      )}`;
      cohortBuckets.set(key, { totalCreated: 0, stillLive: 0 });
    }

    for (const r of rows ?? []) {
      const status = r.status ?? "";
      const createdAt = r.created_at ? new Date(r.created_at) : null;
      const canceledAt = r.canceled_at ? new Date(r.canceled_at) : null;

      if (ACTIVE_STATUSES.has(status)) activeNow++;
      if (status === "paused") pausedNow++;
      if (PAST_DUE_STATUSES.has(status)) pastDueNow++;
      if (CANCELED_STATUSES.has(status)) canceledLifetime++;
      if (createdAt && createdAt >= cutoff30) newSubsLast30d++;
      if (createdAt && createdAt >= cutoff90) newSubsLast90d++;
      if (canceledAt && canceledAt >= cutoff30) canceledLast30d++;
      if (canceledAt && canceledAt >= cutoff90) canceledLast90d++;
      if (r.cancel_at_period_end && ACTIVE_STATUSES.has(status)) {
        pendingCancellations++;
      }

      // Cohort: only subs created in the last 6 calendar months. The
      // bucket key is the month of `created_at` in UTC so the counter
      // matches the SPA's UTC-anchored x-axis labels.
      if (createdAt && createdAt >= cohortStart) {
        const key = `${createdAt.getUTCFullYear()}-${String(
          createdAt.getUTCMonth() + 1,
        ).padStart(2, "0")}`;
        const bucket = cohortBuckets.get(key);
        if (bucket) {
          bucket.totalCreated++;
          if (LIVE_STATUSES.has(status)) bucket.stillLive++;
        }
      }
    }
    // Touch cohortStartIso so the linter can see why we computed it —
    // the Map seeding above already enforces the same window.
    void cohortStartIso;

    const counters = {
      activeNow,
      pausedNow,
      pastDueNow,
      canceledLifetime,
      newSubsLast30d,
      newSubsLast90d,
      canceledLast30d,
      canceledLast90d,
      pendingCancellations,
    };

    const churnDenominator = activeNow + canceledLast30d;
    const churnRate30d =
      churnDenominator > 0
        ? (canceledLast30d / churnDenominator) * 100
        : 0;

    const cohort = Array.from(cohortBuckets.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([cohortMonth, b]) => ({
        cohortMonth,
        totalCreated: b.totalCreated,
        stillLive: b.stillLive,
      }));

    res.json({
      counters,
      churnRate30d: Number(churnRate30d.toFixed(2)),
      cohort,
    });
  },
);

export default router;
