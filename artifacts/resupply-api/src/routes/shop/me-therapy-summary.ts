// /shop/me/therapy-summary — patient-facing view of recent CPAP usage.
//
//   GET /shop/me/therapy-summary
//
// Returns the last 30 nights of `patient_therapy_nights` for the
// patient row whose email matches the signed-in shop customer's
// email_lower, plus a small set of pre-computed totals the SPA needs
// to render headline numbers without doing arithmetic over the
// nights array (avg usage, avg AHI, avg leak, Medicare-style
// adherence rate over the window).
//
// Why a summary endpoint and not raw nights:
//   The same totals are needed by the dashboard card (compact
//   summary), the trend chart (per-night array), and any future
//   compliance widget. Doing the arithmetic server-side keeps the
//   SPA bundle small and the totals consistent across surfaces.
//
// Match strategy: same email-only lookup as /shop/me/insights. See
// that file's preamble for the HIPAA rationale (refusing to merge
// shop_customers with patients without an explicit consent flow).
//
// PHI / log posture:
//   * The response includes per-night usage minutes, AHI, leak rate
//     and pressure — these are the patient's own data, displayed to
//     the patient. No different from /account showing the patient
//     their own saved address.
//   * Logging is structural: customerId + nightsCount only. Per-
//     night metrics never go to the logger.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

/** Window the dashboard card and chart cover. Matches the Medicare
 *  90-day adherence trial's "any 30 consecutive days" probe so the
 *  derived `complianceRate` reads like the payer's number. */
const WINDOW_NIGHTS = 30;

/** Medicare adherence threshold: ≥4 hours of use on a given night
 *  counts as a compliant night. The 70%-of-nights rollup is computed
 *  in the projection. */
const COMPLIANT_HOURS_PER_NIGHT = 4;

/** Source priority when the same night exists from multiple feeds.
 *  Devices first, then apps, then manual entry. Lower index wins. */
const SOURCE_PRIORITY: Record<string, number> = {
  resmed_airview: 0,
  philips_care: 1,
  health_connect: 2,
  manual: 3,
};

interface TherapyNightProjection {
  date: string;
  usageHours: number | null;
  ahi: number | null;
  leakLMin: number | null;
  pressureP95Cmh2o: number | null;
  source: string;
}

interface TherapySummaryResponse {
  /** True when the customer email matched a single patient row AND
   *  that patient has at least one night in the window. False when
   *  either the email match misses or the matched patient has no
   *  imported nights yet. The SPA branches on this to show either
   *  the dashboard or a "we'll surface your therapy data here once
   *  it starts flowing" empty state. */
  hasData: boolean;
  /** True when the customer email matched a single patient row,
   *  regardless of whether that patient has nights yet. Lets the
   *  empty state distinguish "we don't have any data yet" from
   *  "we couldn't find your patient record". */
  patientLinked: boolean;
  windowNights: number;
  nightsWithData: number;
  /** Inclusive — both ends are dates the dashboard can label. Null
   *  when nightsWithData is 0. */
  windowStartDate: string | null;
  windowEndDate: string | null;
  avgUsageHours: number | null;
  avgAhi: number | null;
  avgLeakLMin: number | null;
  /** Number of nights in the window where usage_hours >=
   *  COMPLIANT_HOURS_PER_NIGHT. Medicare's adherence definition. */
  compliantNights: number | null;
  /** compliantNights / nightsWithData, rounded to 2 decimals.
   *  Compare against 0.70 to read the Medicare threshold. */
  complianceRate: number | null;
  nights: TherapyNightProjection[];
}

/**
 * Resolve the patient row whose `email` matches `customerEmail`
 * case-insensitively, but only if the match is unambiguous. Same
 * implementation as /shop/me/insights — duplicated rather than
 * shared so the two routes can evolve independently (e.g. if the
 * insights route eventually adds a consent gate, this route's
 * weaker matching shouldn't have to follow).
 */
async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return rows[0]!.id;
}

router.get("/shop/me/therapy-summary", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  const customerEmail = req.shopCustomerEmail;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  if (!customerEmail) {
    res.json(emptyResponse({ patientLinked: false }));
    return;
  }

  const patientId = await resolveSinglePatientByEmail(customerEmail);
  if (!patientId) {
    res.json(emptyResponse({ patientLinked: false }));
    return;
  }

  // Fetch the window with one extra day on the lower bound so a
  // patient whose night_date is in their local timezone but stored
  // as the cloud-reported UTC date doesn't drop off the edge.
  // Server-side filter so PostgREST does the row prune; we re-trim
  // to the exact window after deduping.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (WINDOW_NIGHTS + 1));
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select(
      "night_date, source, usage_minutes, ahi, leak_rate_l_min, pressure_p95_cmh2o",
    )
    .eq("patient_id", patientId)
    .gte("night_date", cutoffDate)
    .order("night_date", { ascending: false })
    .limit(WINDOW_NIGHTS * 4); // up to 4 sources per night
  if (error) throw error;

  const projection = projectNights(rows ?? []);

  logger.info(
    {
      customerId,
      nightsCount: projection.nightsWithData,
    },
    "shop.me.therapy-summary.served",
  );

  res.json(projection);
});

interface TherapyNightRow {
  night_date: string;
  source: string;
  usage_minutes: number | null;
  // PostgREST returns numeric as string to preserve precision.
  ahi: string | null;
  leak_rate_l_min: string | null;
  pressure_p95_cmh2o: string | null;
}

function projectNights(rows: TherapyNightRow[]): TherapySummaryResponse {
  // Deduplicate by night_date — when the same night exists from
  // multiple sources, keep the highest-priority feed only.
  const byDate = new Map<string, TherapyNightRow>();
  for (const row of rows) {
    const existing = byDate.get(row.night_date);
    if (!existing) {
      byDate.set(row.night_date, row);
      continue;
    }
    const newRank = SOURCE_PRIORITY[row.source] ?? 99;
    const oldRank = SOURCE_PRIORITY[existing.source] ?? 99;
    if (newRank < oldRank) byDate.set(row.night_date, row);
  }

  // Trim to the most recent WINDOW_NIGHTS dates. Sorting descending
  // mirrors what the SPA wants (newest first for the chart x-axis
  // when reversed; trivial to reverse client-side).
  const allNights = Array.from(byDate.values()).sort((a, b) =>
    a.night_date < b.night_date ? 1 : -1,
  );
  const windowNights = allNights.slice(0, WINDOW_NIGHTS);

  if (windowNights.length === 0) {
    return emptyResponse({ patientLinked: true });
  }

  // Project to the SPA shape. Convert numerics from PostgREST's
  // string form to numbers; keep null when the device omitted the
  // metric (e.g. usage but no AHI on a power-loss night).
  const nights: TherapyNightProjection[] = windowNights.map((r) => ({
    date: r.night_date,
    usageHours:
      r.usage_minutes == null
        ? null
        : Math.round((r.usage_minutes / 60) * 100) / 100,
    ahi: r.ahi == null ? null : Number(r.ahi),
    leakLMin: r.leak_rate_l_min == null ? null : Number(r.leak_rate_l_min),
    pressureP95Cmh2o:
      r.pressure_p95_cmh2o == null ? null : Number(r.pressure_p95_cmh2o),
    source: r.source,
  }));

  // Aggregate, ignoring null entries per metric so a humidifier-only
  // night doesn't drag the AHI average to zero.
  const usage = nights
    .map((n) => n.usageHours)
    .filter((v): v is number => v != null);
  const ahi = nights.map((n) => n.ahi).filter((v): v is number => v != null);
  const leak = nights
    .map((n) => n.leakLMin)
    .filter((v): v is number => v != null);
  const compliantNights = usage.filter(
    (h) => h >= COMPLIANT_HOURS_PER_NIGHT,
  ).length;

  // Compute window bounds from the nights we actually have, not the
  // 30-day cutoff — patients with a 5-night history shouldn't see a
  // 30-day x-axis stretching mostly into the past.
  const dates = nights.map((n) => n.date).sort();

  return {
    hasData: true,
    patientLinked: true,
    windowNights: WINDOW_NIGHTS,
    nightsWithData: nights.length,
    windowStartDate: dates[0] ?? null,
    windowEndDate: dates[dates.length - 1] ?? null,
    avgUsageHours: usage.length > 0 ? round2(avg(usage)) : null,
    avgAhi: ahi.length > 0 ? round2(avg(ahi)) : null,
    avgLeakLMin: leak.length > 0 ? round2(avg(leak)) : null,
    compliantNights: usage.length > 0 ? compliantNights : null,
    complianceRate:
      usage.length > 0 ? round2(compliantNights / usage.length) : null,
    nights,
  };
}

function emptyResponse(opts: {
  patientLinked: boolean;
}): TherapySummaryResponse {
  return {
    hasData: false,
    patientLinked: opts.patientLinked,
    windowNights: WINDOW_NIGHTS,
    nightsWithData: 0,
    windowStartDate: null,
    windowEndDate: null,
    avgUsageHours: null,
    avgAhi: null,
    avgLeakLMin: null,
    compliantNights: null,
    complianceRate: null,
    nights: [],
  };
}

function avg(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default router;
