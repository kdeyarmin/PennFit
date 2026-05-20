// /admin/patients/:id/address-history — append-only audit trail.
//
//   GET  /admin/patients/:id/address-history
//   POST /admin/patients/:id/address-history    body: address fields + reason

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.object({ id: z.string().uuid() });

const addressBody = z
  .object({
    line1: z.string().trim().max(200).nullable().optional(),
    line2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(64).nullable().optional(),
    postalCode: z.string().trim().max(32).nullable().optional(),
    country: z.string().trim().length(2).nullable().optional(),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();

router.get(
  "/admin/patients/:id/address-history",
  // Read-only audit-trail view. `patients.read` is held by every
  // current role, so this preserves access while codifying scope.
  requirePermission("patients.read"),
  async (req, res) => {
    const params = patientIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_address_history")
      .select(
        "id, line1, line2, city, state, postal_code, country, reason, changed_by_user_id, created_at",
      )
      .eq("patient_id", params.data.id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({
      history: (data ?? []).map((r) => ({
        id: r.id,
        line1: r.line1,
        line2: r.line2,
        city: r.city,
        state: r.state,
        postalCode: r.postal_code,
        country: r.country,
        reason: r.reason,
        changedByUserId: r.changed_by_user_id,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/admin/patients/:id/address-history",
  // Mutating route — records a new address-change row + audit entry.
  // Scoped to `patients.update` (admin/supervisor/csr/fitter/agent).
  // INTENTIONAL TIGHTENING: removes access for `fulfillment` and
  // `compliance_officer`, neither of which has a workflow that
  // requires editing a patient's address history (fulfillment ships
  // to the address already on file; compliance officer audits but
  // does not edit). If a workflow surfaces that requires either
  // role, grant `patients.update` to the role in rbac.ts rather
  // than loosening this route.
  requirePermission("patients.update"),
  adminRateLimit({
    name: "patient_address_history.append",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = patientIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = addressBody.safeParse(req.body);
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_address_history")
      .insert({
        patient_id: params.data.id,
        line1: parsed.data.line1 ?? null,
        line2: parsed.data.line2 ?? null,
        city: parsed.data.city ?? null,
        state: parsed.data.state ?? null,
        postal_code: parsed.data.postalCode ?? null,
        country: parsed.data.country ?? null,
        reason: parsed.data.reason,
        changed_by_user_id: req.adminUserId ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "patient.address.changed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_address_history",
      targetId: row.id,
      metadata: {
        patient_id: params.data.id,
        reason: parsed.data.reason,
        // Address line content is NOT in the audit envelope — PHI
        // lives on the row itself.
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.address.changed audit failed");
    });

    res.status(201).json({ id: row.id });
  },
);

export default router;
