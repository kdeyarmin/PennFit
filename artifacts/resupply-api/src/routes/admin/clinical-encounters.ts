// /admin/patients/:patientId/clinical-encounters — append-only clinician
// documentation (migration 0188 / roadmap F3).
//
//   GET  /admin/patients/:patientId/clinical-encounters  — list (newest first)
//   POST /admin/patients/:patientId/clinical-encounters  — author an encounter
//
// Append-only: there is no update/delete. A correction is a new
// encounter (the clinical record is a log, not a mutable document).
//
// Access: read on `clinical.read`, write on `clinical.note.write` — the
// rt (clinician) role + the management tiers hold these; the front-line
// customer_service_rep bucket does not.
//
// PHI posture: the structured fields + note describe a patient's care
// and ARE PHI. The audit envelope records the patient_id + encounter_type
// ONLY — never the clinical content — and the safe logs are counts only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.string().trim().min(1).max(128);

const ENCOUNTER_TYPES = [
  "mask_fit",
  "troubleshoot",
  "setup_education",
  "adherence_intervention",
  "phone",
  "other",
] as const;

const createSchema = z
  .object({
    encounterType: z.enum(ENCOUNTER_TYPES),
    reason: z.string().trim().max(2000).optional(),
    assessment: z.string().trim().max(4000).optional(),
    intervention: z.string().trim().max(4000).optional(),
    plan: z.string().trim().max(4000).optional(),
    followUpAt: z.string().datetime().optional(),
    note: z.string().trim().max(8000).optional(),
    linkedAlertId: z.string().trim().max(128).optional(),
    linkedEpisodeId: z.string().trim().max(128).optional(),
  })
  .strict()
  .refine(
    (d) =>
      [d.reason, d.assessment, d.intervention, d.plan, d.note].some(
        (s) => s != null && s.trim().length > 0,
      ),
    { message: "An encounter needs at least a note or one structured field." },
  );

router.get(
  "/admin/patients/:patientId/clinical-encounters",
  // Limiter before the auth gate (CodeQL "sensitive data read from GET" /
  // "missing rate limiting" wants the throttle ahead of authorization).
  adminReadRateLimiter,
  requirePermission("clinical.read"),
  async (req, res) => {
    const parsed = patientIdParam.safeParse(req.params.patientId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const patientId = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("clinical_encounters")
      .select(
        "id, encounter_type, reason, assessment, intervention, plan, follow_up_at, note, linked_alert_id, linked_episode_id, author_email, created_at",
      )
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    // Safe log: count + who looked. NO clinical content.
    req.log?.info(
      { patientId, count: (data ?? []).length, adminEmail: req.adminEmail },
      "admin.clinical_encounters.list",
    );

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    res.json({
      encounters: rows.map((r) => ({
        id: r.id,
        encounterType: r.encounter_type,
        reason: r.reason,
        assessment: r.assessment,
        intervention: r.intervention,
        plan: r.plan,
        followUpAt: r.follow_up_at,
        note: r.note,
        linkedAlertId: r.linked_alert_id,
        linkedEpisodeId: r.linked_episode_id,
        authorEmail: r.author_email,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/admin/patients/:patientId/clinical-encounters",
  requirePermission("clinical.note.write"),
  adminRateLimit({ name: "clinical_encounters.create", preset: "mutation" }),
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.patientId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const patientId = idCheck.data;

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
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("clinical_encounters")
      .insert({
        patient_id: patientId,
        author_user_id: req.adminUserId ?? null,
        author_email: req.adminEmail ?? "<unknown>",
        encounter_type: d.encounterType,
        reason: d.reason ?? null,
        assessment: d.assessment ?? null,
        intervention: d.intervention ?? null,
        plan: d.plan ?? null,
        follow_up_at: d.followUpAt ?? null,
        note: d.note ?? null,
        linked_alert_id: d.linkedAlertId ?? null,
        linked_episode_id: d.linkedEpisodeId ?? null,
      })
      .select("id, created_at")
      .single();
    if (error) {
      res.status(500).json({ error: "insert_failed", message: error.message });
      return;
    }

    // Audit — structural metadata ONLY. No clinical content (PHI).
    await logAudit({
      action: "clinical_encounter.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "clinical_encounters",
      targetId: (inserted as { id: string }).id,
      metadata: { patient_id: patientId, encounter_type: d.encounterType },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "clinical_encounter.create audit write failed");
    });

    res.status(201).json({
      id: (inserted as { id: string; created_at: string }).id,
      createdAt: (inserted as { id: string; created_at: string }).created_at,
    });
  },
);

export default router;
