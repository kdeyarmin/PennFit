// /admin/patients/:patientId/setup-checklist — new-patient setup-guidance
// checklist (migration 0191 / Phase 1, RT #27).
//
//   GET  /admin/patients/:patientId/setup-checklist          — canonical
//        steps merged with each step's recorded status
//   PUT  /admin/patients/:patientId/setup-checklist/:stepKey — set a step
//
// Gated by the F3 clinical perms: read on clinical.read, write on
// clinical.note.write (RT + management). A step note may describe the
// patient (PHI), so the audit envelope records patient_id + step_key +
// status only — never the note.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// The canonical first-night setup steps, in order. Adding a step here
// surfaces it for every patient; recorded statuses are keyed by step_key
// so adding / reordering steps is safe.
const SETUP_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "mask_fit_seal", label: "Mask fit + seal check" },
  { key: "humidifier", label: "Humidifier set + filled" },
  { key: "ramp", label: "Ramp / pressure comfort explained" },
  { key: "cleaning", label: "Cleaning + maintenance routine" },
  { key: "data_app", label: "Companion app / data tracking set up" },
  { key: "followup_scheduled", label: "First follow-up scheduled" },
];
const STEP_KEYS = new Set(SETUP_STEPS.map((s) => s.key));

const patientIdParam = z.string().trim().min(1).max(128);

const putSchema = z
  .object({
    status: z.enum(["pending", "done", "na"]),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

router.get(
  "/admin/patients/:patientId/setup-checklist",
  requirePermission("clinical.read"),
  adminRateLimit({ name: "setup_checklist.get", preset: "query" }),
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.patientId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const patientId = idCheck.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("setup_checklist_items")
      .select(
        "step_key, status, note, completed_by_email, completed_at, updated_at",
      )
      .eq("patient_id", patientId);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    const recorded = new Map<string, Record<string, unknown>>();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      if (typeof r.step_key === "string") recorded.set(r.step_key, r);
    }

    const steps = SETUP_STEPS.map((s) => {
      const r = recorded.get(s.key);
      return {
        stepKey: s.key,
        label: s.label,
        status: r ? r.status : "pending",
        note: r ? r.note : null,
        completedByEmail: r ? r.completed_by_email : null,
        completedAt: r ? r.completed_at : null,
        updatedAt: r ? r.updated_at : null,
      };
    });
    res.json({ steps });
  },
);

router.put(
  "/admin/patients/:patientId/setup-checklist/:stepKey",
  requirePermission("clinical.note.write"),
  adminRateLimit({ name: "setup_checklist.upsert", preset: "mutation" }),
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.patientId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const patientId = idCheck.data;

    const stepKey = String(req.params.stepKey ?? "");
    if (!STEP_KEYS.has(stepKey)) {
      res.status(400).json({ error: "invalid_step_key" });
      return;
    }

    const parsed = putSchema.safeParse(req.body);
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
    const { status, note } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .schema("resupply")
      .from("setup_checklist_items")
      .upsert(
        {
          patient_id: patientId,
          step_key: stepKey,
          status,
          note: note ?? null,
          completed_by_email:
            status === "done" ? (req.adminEmail ?? null) : null,
          completed_at: status === "done" ? nowIso : null,
          updated_at: nowIso,
        },
        { onConflict: "patient_id,step_key" },
      );
    if (error) {
      res.status(500).json({ error: "upsert_failed", message: error.message });
      return;
    }

    await logAudit({
      action: "setup_checklist.upsert",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "setup_checklist_items",
      targetId: `${patientId}:${stepKey}`,
      metadata: { patient_id: patientId, step_key: stepKey, status },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "setup_checklist.upsert audit write failed");
    });

    res.json({ stepKey, status });
  },
);

export default router;
