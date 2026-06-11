// /admin/clinical/outreach — proactive clinical outreach (RT #23).
//
//   GET  /admin/clinical/outreach/eligible  (clinical.read)
//     Patients with an open intervention who are due for outreach (not
//     contacted within the frequency-cap window). Category + ids only.
//
//   POST /admin/clinical/outreach/run        (clinical.intervention.write)
//     Send the templated nudge to the eligible batch (capped). Outward
//     contact, consent/DND/frequency-cap gated in lib/clinical/
//     clinical-outreach.ts; returns a counts summary.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  runClinicalOutreachBatch,
  selectOutreachTargets,
  type OutreachTarget,
} from "../../lib/clinical/clinical-outreach";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";

const router: IRouter = Router();

const DEFAULT_MIN_HOURS = 24 * 14;

async function loadEligible(
  minHours: number,
  cap: number,
): Promise<OutreachTarget[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("clinical_encounters")
    .select("id, patient_id, assessment_category, created_at")
    .eq("encounter_type", "adherence_intervention")
    .eq("outcome_status", "pending")
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    patient_id: string;
    assessment_category: string | null;
  }>;
  if (rows.length === 0) return [];

  const patientIds = [...new Set(rows.map((r) => r.patient_id))];
  const lastOutreach = new Map<string, string>();
  const { data: logs } = await supabase
    .schema("resupply")
    .from("clinical_outreach_log")
    .select("patient_id, created_at")
    .in("patient_id", patientIds)
    .order("created_at", { ascending: false });
  for (const l of (logs ?? []) as Array<{
    patient_id: string;
    created_at: string;
  }>) {
    if (!lastOutreach.has(l.patient_id)) {
      lastOutreach.set(l.patient_id, l.created_at);
    }
  }

  return selectOutreachTargets(
    rows.map((r) => ({
      patientId: r.patient_id,
      interventionEncounterId: r.id,
      assessmentCategory: r.assessment_category,
    })),
    lastOutreach,
    { cap, minHoursBetweenOutreach: minHours },
  );
}

router.get(
  "/admin/clinical/outreach/eligible",
  adminReadRateLimiter,
  requirePermission("clinical.read"),
  async (_req, res) => {
    try {
      const targets = await loadEligible(DEFAULT_MIN_HOURS, 500);
      res.json({
        eligible: targets.map((t) => ({
          patientId: t.patientId,
          interventionId: t.interventionEncounterId,
          category: t.assessmentCategory,
        })),
        count: targets.length,
      });
    } catch (err) {
      res.status(500).json({
        error: "query_failed",
        message: err instanceof Error ? err.message : "unknown",
      });
    }
  },
);

const runSchema = z
  .object({ cap: z.coerce.number().int().min(1).max(200).optional() })
  .strip();

router.post(
  "/admin/clinical/outreach/run",
  requirePermission("clinical.intervention.write"),
  // Dials/texts/emails patients or hammers the clearinghouse —
  // throttle like every sibling outbound-contact endpoint.
  adminRateLimit({ name: "clinical.outreach_run", preset: "bulk" }),
  async (req, res) => {
    const parsed = runSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const summary = await runClinicalOutreachBatch({
      cap: parsed.data.cap ?? 50,
    });
    req.log?.info(
      {
        event: "admin.clinical_outreach.run",
        ...summary,
        adminEmail: req.adminEmail,
      },
      "admin.clinical_outreach.run",
    );
    res.json({ summary });
  },
);

export default router;
