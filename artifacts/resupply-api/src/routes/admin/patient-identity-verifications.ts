// /admin/patients/:id/identity-verifications — record + list
// identity-verification events.
//
//   GET  /admin/patients/:id/identity-verifications
//   POST /admin/patients/:id/identity-verifications
//        Body: { method, result, notes? }
//
// We do NOT take an SSN or government ID number in the request body.
// The CSR performs the comparison out-of-band; this endpoint just
// records the outcome.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/patients/:id/identity-verifications",
  requireAdmin,
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_identity_verifications")
      .select(
        "id, method, result, notes, verified_by_user_id, created_at",
      )
      .eq("patient_id", idParse.data)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({
      verifications: (data ?? []).map((r) => ({
        id: r.id,
        method: r.method,
        result: r.result,
        notes: r.notes,
        verifiedByUserId: r.verified_by_user_id,
        createdAt: r.created_at,
      })),
    });
  },
);

const body = z
  .object({
    method: z.enum([
      "dob_last4_ssn",
      "gov_id_upload",
      "video_attest",
      "in_person",
    ]),
    result: z.enum(["pass", "fail", "skipped"]),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/identity-verifications",
  requireAdmin,
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_identity_verifications")
      .insert({
        patient_id: idParse.data,
        method: parsed.data.method,
        result: parsed.data.result,
        notes: parsed.data.notes ?? null,
        verified_by_user_id: req.adminUserId ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "patient.identity.verified",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_identity_verifications",
      targetId: data.id,
      metadata: {
        // Both fields are non-PHI categorical labels.
        method: parsed.data.method,
        result: parsed.data.result,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.identity.verified audit failed");
    });
    res.status(201).json({ id: data.id });
  },
);

export default router;
