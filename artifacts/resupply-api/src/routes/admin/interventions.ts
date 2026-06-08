// RT #21 — structured non-adherence intervention plan + outcome.
//
//   POST  /admin/patients/:patientId/interventions   (clinical.intervention.write)
//     Document why a patient fell off therapy (structured category) and
//     the plan to recover them, optionally linked to the fleet alert
//     that flagged them. Persists as a clinical_encounters row of type
//     'adherence_intervention' (so it also shows in the patient's
//     clinical timeline) with outcome_status seeded to 'pending'.
//
//   GET   /admin/clinical/interventions              (clinical.read)
//     The RT worklist: open interventions first (pending outcome /
//     follow-up due), via a pure tested merge+sort.
//
//   PATCH /admin/interventions/:id/outcome           (clinical.intervention.write)
//     Record whether the plan worked on a later re-check (improved /
//     no_change / worsened / unknown). This is the MANUAL outcome the
//     RT attests to.
//
//   GET   /admin/interventions/:id/outcome-measurement  (clinical.read)
//     The AUTOMATED outcome signal that complements the manual PATCH
//     above. Compares the patient's therapy metrics in the window
//     BEFORE the intervention date to the window AFTER it (average
//     nightly usage minutes, Medicare-style compliance rate, AHI, and
//     leak) and derives improved / no_change / worsened from the usage
//     delta — so an RT can see whether the refit/coaching actually
//     moved the numbers instead of guessing. Read-only.
//
// PHI posture: clinical content (reason/plan) is returned to the
// clinical.read holder (their tool), but NEVER logged — the app logger
// sees ids + category + outcome + counts only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export const ASSESSMENT_CATEGORIES = [
  "mask_leak",
  "claustrophobia",
  "pressure_intolerance",
  "motivation",
  "congestion",
  "mask_discomfort",
  "mouth_breathing",
  "travel_disruption",
  "other",
] as const;
export type AssessmentCategory = (typeof ASSESSMENT_CATEGORIES)[number];

export const OUTCOME_STATUSES = [
  "pending",
  "improved",
  "no_change",
  "worsened",
  "unknown",
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export interface InterventionRow {
  id: string;
  patient_id: string;
  assessment_category: string | null;
  outcome_status: string | null;
  reason: string | null;
  plan: string | null;
  follow_up_at: string | null;
  author_email: string | null;
  created_at: string;
}

export interface InterventionItem {
  id: string;
  patientId: string;
  assessmentCategory: string | null;
  outcomeStatus: string;
  reason: string | null;
  plan: string | null;
  followUpAt: string | null;
  authorEmail: string | null;
  createdAt: string;
  /** Open = outcome still pending. Drives the worklist sort + a UI badge. */
  open: boolean;
}

function ts(v: string | null): number {
  if (!v) return Number.POSITIVE_INFINITY; // no follow-up date sorts last among open
  const t = Date.parse(v);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Pure: shape intervention rows into the worklist. Open (pending-outcome)
 * items first, then by soonest follow-up (overdue first); resolved items
 * after, newest-first. No I/O — unit-tested directly.
 */
export function buildInterventionWorklist(
  rows: InterventionRow[],
): InterventionItem[] {
  const items: InterventionItem[] = rows.map((r) => {
    const outcomeStatus = (r.outcome_status ?? "pending").trim() || "pending";
    return {
      id: r.id,
      patientId: r.patient_id,
      assessmentCategory: r.assessment_category,
      outcomeStatus,
      reason: r.reason,
      plan: r.plan,
      followUpAt: r.follow_up_at,
      authorEmail: r.author_email,
      createdAt: r.created_at,
      open: outcomeStatus === "pending",
    };
  });

  return items.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (a.open) {
      // Both open → soonest follow-up first (overdue/imminent on top).
      return ts(a.followUpAt) - ts(b.followUpAt);
    }
    // Both resolved → newest first.
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

// ── RT #21b — automated before/after therapy-metric outcome ──────────
//
// Pure, I/O-free measurement core (unit-tested directly). Given the
// intervention's anchor date and the patient's therapy nights in a
// symmetric window around it, split the nights into BEFORE (night_date
// strictly before the anchor day) and AFTER (on or after), then compare
// the two windows. The derived `signal` is driven by average nightly
// usage minutes — the clinically meaningful adherence metric — with AHI
// and leak reported alongside as context.

/** ≥ this many usage-bearing nights on EACH side or the signal is `insufficient_data`. */
export const OUTCOME_MIN_NIGHTS_PER_SIDE = 3;
/** Medicare compliant-night threshold (≥ 4 h). */
const OUTCOME_COMPLIANT_MINUTES = 240;
/** ± avg-usage swing (min/night) that flips the signal off `no_change`. */
const OUTCOME_USAGE_DELTA_MINUTES = 30;

export interface TherapyNightInput {
  /** ISO date (YYYY-MM-DD). */
  nightDate: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakLMin: number | null;
}

export interface OutcomeWindowStats {
  /** Deduped night rows that fell in this window. */
  nights: number;
  /** Of those, how many carried a usage value (denominator for compliance). */
  nightsWithUsage: number;
  avgUsageMinutes: number | null;
  /** Nights with usage ≥ 240 min. */
  compliantNights: number;
  /** compliantNights / nightsWithUsage, as a 0–100 percentage. */
  complianceRatePct: number | null;
  avgAhi: number | null;
  avgLeak: number | null;
}

export type OutcomeSignal =
  | "improved"
  | "no_change"
  | "worsened"
  | "insufficient_data";

export interface OutcomeMeasurement {
  before: OutcomeWindowStats;
  after: OutcomeWindowStats;
  deltas: {
    usageMinutes: number | null;
    complianceRatePct: number | null;
    ahi: number | null;
    leak: number | null;
  };
  signal: OutcomeSignal;
  minNightsPerSide: number;
}

function mean(vals: number[]): number | null {
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function round1(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}

function numeric(vals: (number | null)[]): number[] {
  return vals.filter((v): v is number => v != null && Number.isFinite(v));
}

function computeWindowStats(nights: TherapyNightInput[]): OutcomeWindowStats {
  const usage = numeric(nights.map((n) => n.usageMinutes));
  const compliantNights = usage.filter(
    (u) => u >= OUTCOME_COMPLIANT_MINUTES,
  ).length;
  return {
    nights: nights.length,
    nightsWithUsage: usage.length,
    avgUsageMinutes: round1(mean(usage)),
    compliantNights,
    complianceRatePct:
      usage.length > 0 ? round1((compliantNights / usage.length) * 100) : null,
    avgAhi: round1(mean(numeric(nights.map((n) => n.ahi)))),
    avgLeak: round1(mean(numeric(nights.map((n) => n.leakLMin)))),
  };
}

/**
 * Pure: compute the before/after therapy-metric comparison for one
 * intervention. `anchorDate` is the intervention day (YYYY-MM-DD). Nights
 * are deduped by date (first occurrence wins — a patient synced from two
 * clouds can carry duplicate dates). No I/O.
 */
export function computeOutcomeMeasurement(input: {
  anchorDate: string;
  nights: TherapyNightInput[];
  minNightsPerSide?: number;
}): OutcomeMeasurement {
  const minNights = input.minNightsPerSide ?? OUTCOME_MIN_NIGHTS_PER_SIDE;

  const seen = new Set<string>();
  const deduped: TherapyNightInput[] = [];
  for (const n of input.nights) {
    if (!n?.nightDate || seen.has(n.nightDate)) continue;
    seen.add(n.nightDate);
    deduped.push(n);
  }

  // night_date and anchorDate are both YYYY-MM-DD, so lexical compare = date compare.
  const before = computeWindowStats(
    deduped.filter((n) => n.nightDate < input.anchorDate),
  );
  const after = computeWindowStats(
    deduped.filter((n) => n.nightDate >= input.anchorDate),
  );

  const delta = (a: number | null, b: number | null): number | null =>
    a == null || b == null ? null : round1(a - b);
  const deltas = {
    usageMinutes: delta(after.avgUsageMinutes, before.avgUsageMinutes),
    complianceRatePct: delta(after.complianceRatePct, before.complianceRatePct),
    ahi: delta(after.avgAhi, before.avgAhi),
    leak: delta(after.avgLeak, before.avgLeak),
  };

  let signal: OutcomeSignal;
  if (before.nightsWithUsage < minNights || after.nightsWithUsage < minNights) {
    signal = "insufficient_data";
  } else {
    const d = deltas.usageMinutes ?? 0;
    signal =
      d >= OUTCOME_USAGE_DELTA_MINUTES
        ? "improved"
        : d <= -OUTCOME_USAGE_DELTA_MINUTES
          ? "worsened"
          : "no_change";
  }

  return { before, after, deltas, signal, minNightsPerSide: minNights };
}

/** Add `delta` days to a YYYY-MM-DD day in UTC, returning YYYY-MM-DD. */
function addDaysIso(dayIso: string, delta: number): string {
  const d = new Date(`${dayIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const patientIdParam = z.string().trim().min(1).max(128);

const createSchema = z
  .object({
    assessmentCategory: z.enum(ASSESSMENT_CATEGORIES),
    reason: z.string().trim().max(4000).optional(),
    plan: z.string().trim().max(4000).optional(),
    followUpAt: z.string().datetime().optional(),
    linkedAlertId: z.string().trim().max(128).optional(),
  })
  .strict();

router.post(
  "/admin/patients/:patientId/interventions",
  requirePermission("clinical.intervention.write"),
  async (req, res) => {
    const idParsed = patientIdParam.safeParse(req.params.patientId);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const d = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("clinical_encounters")
      .insert({
        patient_id: idParsed.data,
        author_user_id: req.adminUserId ?? null,
        author_email: req.adminEmail ?? "<unknown>",
        encounter_type: "adherence_intervention",
        assessment_category: d.assessmentCategory,
        reason: d.reason ?? null,
        plan: d.plan ?? null,
        follow_up_at: d.followUpAt ?? null,
        linked_alert_id: d.linkedAlertId ?? null,
        outcome_status: "pending",
      } as unknown as Record<string, unknown>)
      .select("id, created_at")
      .maybeSingle();
    if (error || !data) {
      res.status(500).json({ error: "create_failed" });
      return;
    }

    // Category + ids only — never reason/plan (PHI).
    req.log?.info(
      {
        event: "admin.intervention.created",
        patient_id: idParsed.data,
        assessment_category: d.assessmentCategory,
        adminEmail: req.adminEmail,
      },
      "admin.intervention.created",
    );

    res
      .status(201)
      .json({ id: (data as { id: string }).id, outcomeStatus: "pending" });
  },
);

const windowSchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(120),
});

router.get(
  "/admin/clinical/interventions",
  adminReadRateLimiter,
  requirePermission("clinical.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const since = new Date(
      Date.now() - parsed.data.windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("clinical_encounters")
      .select(
        "id, patient_id, assessment_category, outcome_status, reason, plan, follow_up_at, author_email, created_at",
      )
      .eq("encounter_type", "adherence_intervention")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    const items = buildInterventionWorklist(
      (data ?? []) as unknown as InterventionRow[],
    );
    res.json({
      interventions: items,
      count: items.length,
      openCount: items.filter((i) => i.open).length,
    });
  },
);

const idParam = z.string().trim().min(1).max(128);
const outcomeSchema = z
  .object({ outcomeStatus: z.enum(OUTCOME_STATUSES) })
  .strict();

router.patch(
  "/admin/interventions/:id/outcome",
  requirePermission("clinical.intervention.write"),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = outcomeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("clinical_encounters")
      .update({
        outcome_status: parsed.data.outcomeStatus,
        updated_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>)
      .eq("id", idParsed.data)
      .eq("encounter_type", "adherence_intervention")
      .select("id, outcome_status")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "intervention_not_found" });
      return;
    }

    req.log?.info(
      {
        event: "admin.intervention.outcome",
        intervention_id: idParsed.data,
        outcome_status: parsed.data.outcomeStatus,
        adminEmail: req.adminEmail,
      },
      "admin.intervention.outcome",
    );

    res.json({
      id: (data as { id: string }).id,
      outcomeStatus: parsed.data.outcomeStatus,
    });
  },
);

const measurementQuerySchema = z.object({
  // Symmetric window (days) before and after the intervention date.
  windowDays: z.coerce.number().int().min(7).max(90).default(30),
});

router.get(
  "/admin/interventions/:id/outcome-measurement",
  adminReadRateLimiter,
  requirePermission("clinical.read"),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = measurementQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const windowDays = parsed.data.windowDays;

    const supabase = getSupabaseServiceRoleClient();

    // 1) Resolve the intervention → patient + anchor date.
    const { data: enc, error: encErr } = await supabase
      .schema("resupply")
      .from("clinical_encounters")
      .select("id, patient_id, created_at, assessment_category, outcome_status")
      .eq("id", idParsed.data)
      .eq("encounter_type", "adherence_intervention")
      .maybeSingle();
    if (encErr) {
      res.status(500).json({ error: "query_failed", message: encErr.message });
      return;
    }
    if (!enc) {
      res.status(404).json({ error: "intervention_not_found" });
      return;
    }
    const encounter = enc as {
      patient_id: string;
      created_at: string;
      assessment_category: string | null;
      outcome_status: string | null;
    };
    const anchorDate = encounter.created_at.slice(0, 10);
    const startIso = addDaysIso(anchorDate, -windowDays);
    const endIso = addDaysIso(anchorDate, windowDays);

    // 2) Pull the patient's nights across the symmetric window. Cap the
    //    read at 4× the day-span to bound multi-source duplicate dates
    //    (computeOutcomeMeasurement dedups by date).
    const { data: nights, error: nightsErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("night_date, usage_minutes, ahi, leak_rate_l_min")
      .eq("patient_id", encounter.patient_id)
      .gte("night_date", startIso)
      .lte("night_date", endIso)
      .order("night_date", { ascending: true })
      .limit(windowDays * 2 * 4);
    if (nightsErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: nightsErr.message });
      return;
    }

    const measurement = computeOutcomeMeasurement({
      anchorDate,
      nights: ((nights ?? []) as Record<string, unknown>[]).map((n) => ({
        nightDate: String(n.night_date),
        usageMinutes: n.usage_minutes == null ? null : Number(n.usage_minutes),
        ahi: n.ahi == null ? null : Number(n.ahi),
        leakLMin: n.leak_rate_l_min == null ? null : Number(n.leak_rate_l_min),
      })),
    });

    // Counts + signal only — never the per-night metrics (PHI).
    req.log?.info(
      {
        event: "admin.intervention.outcome_measurement",
        intervention_id: idParsed.data,
        signal: measurement.signal,
        before_nights: measurement.before.nights,
        after_nights: measurement.after.nights,
        adminEmail: req.adminEmail,
      },
      "admin.intervention.outcome_measurement",
    );

    res.json({
      interventionId: idParsed.data,
      patientId: encounter.patient_id,
      assessmentCategory: encounter.assessment_category,
      manualOutcomeStatus: encounter.outcome_status ?? "pending",
      anchorDate,
      windowDays,
      ...measurement,
    });
  },
);

export default router;
