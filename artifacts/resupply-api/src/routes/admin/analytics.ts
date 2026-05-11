// /admin/analytics/* — clinical-side analytics surfaces.
//
//   GET /admin/analytics/resupply-funnel?days=30      — episode flow
//   GET /admin/analytics/compliance-cohorts?days=180  — adherence by
//                                                       signup-month
//                                                       and by payer
//   GET /admin/analytics/csr-productivity?days=14     — per-admin
//                                                       audit-action rollup
//
// All three are read-only aggregations over data we already have.
// No new schema. The window is `days` (1..365, default 30, capped
// so a CSR can't accidentally ask for "last 10 years" and time the
// route out). Aggregation logic lives in lib/analytics/aggregate.ts
// — this route is the DB-read + window-validation + audit layer.
//
// Storefront analytics (orders, email health, mask popularity)
// stays at /admin/storefront/analytics. These routes are about the
// CLINICAL business: resupply throughput, patient adherence, team
// productivity.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  aggregateComplianceCohorts,
  aggregateCsrProductivity,
  aggregateResupplyFunnel,
  type AuditRow,
  type EpisodeRow,
  type PatientCohortPoint,
} from "../../lib/analytics/aggregate";
import {
  COMPLIANT_MINUTES_PER_NIGHT,
  WINDOW_DAYS,
  findBestAdherenceWindow,
} from "../../lib/compliance-attestation";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

router.get(
  "/admin/analytics/resupply-funnel",
  requireAdmin,
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("episodes")
      .select("status")
      .gte("created_at", cutoff);
    if (error) throw error;

    const result = aggregateResupplyFunnel((data ?? []) as EpisodeRow[]);
    res.json({ windowDays: days, ...result });
  },
);

router.get(
  "/admin/analytics/compliance-cohorts",
  requireAdmin,
  async (req, res) => {
    // Default to a wider window than the others — compliance cohorts
    // are most useful at the 6+ month horizon since the 90-day trial
    // doesn't even complete inside a 30-day window.
    const parsed = z
      .object({
        days: z.coerce.number().int().min(30).max(730).optional().default(180),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const supabase = getSupabaseServiceRoleClient();

    // Pull patients onboarded in the window. We don't fetch every
    // patient on file — large practices have tens of thousands of
    // historical rows and the per-patient adherence math below
    // would be expensive. The window bounds the cohort to recently
    // onboarded patients, which is exactly the segment the
    // adherence-trial dashboard is about anyway.
    const { data: patientRows, error: pErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, insurance_payer, created_at")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: true });
    if (pErr) throw pErr;

    const patientIds = (patientRows ?? []).map((r) => r.id);
    if (patientIds.length === 0) {
      res.json({
        windowDays: days,
        byMonth: [],
        byPayer: [],
      });
      return;
    }

    // Bulk-pull every therapy night for the cohort patients. We
    // limit to the first 90 days after their signup window — outside
    // that is irrelevant to the Medicare adherence-trial number.
    // PostgREST has no batch GROUP BY for our use case, so we
    // partition in JS.
    const horizonCutoff = isoDaysAgo(days + 90);
    const { data: nightRows, error: nErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("patient_id, night_date, source, usage_minutes")
      .in("patient_id", patientIds)
      .gte("night_date", horizonCutoff);
    if (nErr) throw nErr;

    const nightsByPatient = new Map<
      string,
      Array<{ date: string; usageMinutes: number | null }>
    >();
    for (const row of nightRows ?? []) {
      const list = nightsByPatient.get(row.patient_id) ?? [];
      list.push({
        date: row.night_date,
        usageMinutes: row.usage_minutes,
      });
      nightsByPatient.set(row.patient_id, list);
    }

    const asOfDate = new Date().toISOString().slice(0, 10);
    const points: PatientCohortPoint[] = (patientRows ?? []).map((patient) => {
      const nights = nightsByPatient.get(patient.id) ?? [];
      let qualifies = false;
      if (nights.length > 0) {
        const sorted = [...nights].sort((a, b) =>
          a.date < b.date ? -1 : 1,
        );
        const anchor = sorted[0]!.date;
        const result = findBestAdherenceWindow(sorted, anchor, asOfDate);
        qualifies = result.qualifies;
      }
      return {
        signedUpAt: patient.created_at,
        qualifies,
        insurancePayer: patient.insurance_payer,
      };
    });

    const aggregated = aggregateComplianceCohorts(points);
    res.json({
      windowDays: days,
      compliantMinutesPerNight: COMPLIANT_MINUTES_PER_NIGHT,
      adherenceWindowDays: WINDOW_DAYS,
      ...aggregated,
    });
  },
);

router.get(
  "/admin/analytics/csr-productivity",
  requireAdmin,
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const supabase = getSupabaseServiceRoleClient();

    // We deliberately pull a single bounded page rather than
    // paginating: a busy team writes ~hundreds of productive audit
    // rows per day. Hard ceiling of 50_000 keeps the response
    // bounded even in pathological cases; logs warn when the cap
    // hits so we know to add pagination.
    const HARD_LIMIT = 50_000;
    const { data, error } = await supabase
      .schema("resupply")
      .from("audit_log")
      .select("operator_email, action, occurred_at")
      .gte("occurred_at", cutoff)
      .order("occurred_at", { ascending: false })
      .limit(HARD_LIMIT);
    if (error) throw error;

    if ((data?.length ?? 0) >= HARD_LIMIT) {
      logger.warn(
        { windowDays: days, count: data?.length },
        "csr_productivity_hard_limit_hit",
      );
    }

    const rows: AuditRow[] = (data ?? []).map((r) => ({
      operatorEmail: r.operator_email,
      action: r.action,
      occurredAt: r.occurred_at,
    }));
    const result = aggregateCsrProductivity(rows, days);
    res.json(result);
  },
);

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export default router;
