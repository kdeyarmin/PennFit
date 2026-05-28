// /admin/patients/:id/fit-override — CSR override of the
// camera-based mask-fit recommendation.
//
//   GET  /admin/patients/:id/fit-override
//   PUT  /admin/patients/:id/fit-override     — upsert (1-per-patient)
//   DELETE /admin/patients/:id/fit-override   — revert to camera

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

router.get(
  "/admin/patients/:id/fit-override",
  // Read-only — current override or null. `patients.read`.
  requirePermission("patients.read"),
  async (req, res) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_fit_overrides")
      .select(
        "patient_id, recommended_mask_sku, recommended_mask_size, rationale, created_by_user_id, created_at, updated_at",
      )
      .eq("patient_id", p.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    res.json({
      override: data
        ? {
            patientId: data.patient_id,
            recommendedMaskSku: data.recommended_mask_sku,
            recommendedMaskSize: data.recommended_mask_size,
            rationale: data.rationale,
            createdByUserId: data.created_by_user_id,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
          }
        : null,
    });
  },
);

const putBody = z
  .object({
    recommendedMaskSku: z.string().trim().min(1).max(64),
    recommendedMaskSize: z.string().trim().max(16).nullable().optional(),
    rationale: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.put(
  "/admin/patients/:id/fit-override",
  // Upsert — overrides the camera recommendation. Existing roles
  // with `patients.update` keep access; the `fit_session.override`
  // perm exists in the catalog but is held only by admin/supervisor/
  // fitter (not csr/agent), so we use `patients.update` here as the
  // broader, role-accurate gate to match the existing access matrix.
  requirePermission("patients.update"),
  adminRateLimit({ name: "patient_fit_overrides.upsert", preset: "mutation" }),
  async (req, res) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = putBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // Upsert by patient_id (PK). On conflict update mask + size +
    // rationale and refresh created_by_user_id to the current actor.
    const { error } = await supabase
      .schema("resupply")
      .from("patient_fit_overrides")
      .upsert(
        {
          patient_id: p.data.id,
          recommended_mask_sku: parsed.data.recommendedMaskSku,
          recommended_mask_size: parsed.data.recommendedMaskSize ?? null,
          rationale: parsed.data.rationale ?? null,
          created_by_user_id: req.adminUserId ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "patient_id" },
      );
    if (error) throw error;
    await logAudit({
      action: "patient.fit_override.set",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_fit_overrides",
      targetId: p.data.id,
      metadata: {
        // SKU is non-PHI; safe to include in audit envelope.
        recommended_mask_sku: parsed.data.recommendedMaskSku,
        recommended_mask_size: parsed.data.recommendedMaskSize ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.fit_override.set audit failed");
    });
    res.json({ ok: true });
  },
);

router.delete(
  "/admin/patients/:id/fit-override",
  // Revert to camera recommendation. Same scope as the PUT.
  requirePermission("patients.update"),
  adminRateLimit({ name: "patient_fit_overrides.delete", preset: "destroy" }),
  async (req, res) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: deleted, error } = await supabase
      .schema("resupply")
      .from("patient_fit_overrides")
      .delete()
      .eq("patient_id", p.data.id)
      .select("patient_id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      // Idempotent success: there was nothing to clear. Don't burn an
      // audit row for a no-op delete, but signal it back so the UI
      // can render "already cleared" instead of pretending we did work.
      res.json({ ok: true, deletedCount: 0 });
      return;
    }
    await logAudit({
      action: "patient.fit_override.cleared",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_fit_overrides",
      targetId: p.data.id,
      metadata: { deletedCount: deleted.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch(() => {});
    res.json({ ok: true, deletedCount: deleted.length });
  },
);

export default router;
