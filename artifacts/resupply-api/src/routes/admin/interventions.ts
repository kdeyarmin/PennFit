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
//     no_change / worsened / unknown). This is the MANUAL outcome — the
//     automated therapy-metric before/after comparison is a follow-up.
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

export default router;
