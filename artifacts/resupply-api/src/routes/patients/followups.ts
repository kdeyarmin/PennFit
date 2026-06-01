// /patients/:id/followups — CSR-scheduled callback reminders per
// patient (Phase 19). Mirrors /admin/shop/customers/:userId/followups
// (Phase 17) for the patient flow.
//
//   GET    /patients/:id/followups          — list (open only)
//   GET    /patients/:id/followups?include=completed — full history
//   POST   /patients/:id/followups          — create
//   PATCH  /patients/:id/followups/:fid/complete — mark complete
//
// Mounted under /patients/* (the resupply patient flow's prefix), not
// /admin/shop/* — patients and shop customers are distinct identity
// surfaces and the FK targets are different tables.
//
// PHI / log posture: bodies are plain text and may carry PHI (call
// summary, family context). Audit envelopes record patient_id +
// body_length + due_at — never the body. Same posture as patient_notes.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.string().uuid();
const followupIdParam = z.string().uuid();

const createSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Followup body cannot be empty.")
      .max(2000, "Followup body must be 2000 characters or fewer."),
    dueAt: z
      .string()
      .datetime({ message: "dueAt must be an ISO 8601 timestamp." }),
  })
  .strict();

router.get(
  "/patients/:id/followups",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = patientIdParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = parsed.data;
    const includeCompleted = req.query.include === "completed";

    const supabase = getSupabaseServiceRoleClient();

    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // ALWAYS order descending so the newest entries are returned
    // when the 100-row cap kicks in. The previous code flipped order
    // to ascending when `includeCompleted` was true — which, for a
    // patient with more than 100 historical completed followups,
    // silently dropped the most-recent ones and surfaced the OLDEST.
    // The UI uses this list to render "recent activity", so a CSR
    // reviewing the past week's calls would see nothing and might
    // re-attempt outreach the patient already received.
    let listQuery = supabase
      .schema("resupply")
      .from("patient_followups")
      .select(
        "id, body, due_at, completed_at, completed_by_email, created_by_email, created_at",
      )
      .eq("patient_id", patientId)
      .order("due_at", { ascending: false })
      .limit(100);
    if (!includeCompleted) listQuery = listQuery.is("completed_at", null);
    const { data: rows, error } = await listQuery;
    if (error) throw error;

    req.log?.info(
      {
        patientId,
        count: rows?.length ?? 0,
        includeCompleted,
        adminEmail: req.adminEmail,
      },
      "patient.followups.list",
    );

    res.json({
      followups: (rows ?? []).map((r) => ({
        id: r.id,
        body: r.body,
        dueAt: r.due_at,
        completedAt: r.completed_at,
        completedByEmail: r.completed_by_email,
        createdByEmail: r.created_by_email,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/patients/:id/followups",
  requireAdmin,
  adminWriteRateLimiter,
  async (req, res) => {
    const parsed = patientIdParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = parsed.data;

    const bodyParsed = createSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { body, dueAt } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();

    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_followups")
      .insert({
        patient_id: patientId,
        body,
        due_at: new Date(dueAt).toISOString(),
        created_by_email: req.adminEmail ?? "<unknown>",
        created_by_user_id: req.adminUserId ?? null,
      })
      .select("id, created_at, due_at")
      .single();
    if (error) throw error;

    await logAudit({
      action: "patient.followup.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_followups",
      targetId: row.id,
      metadata: {
        patient_id: patientId,
        body_length: body.length,
        due_at: row.due_at,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.followup.create audit write failed");
    });

    res.status(201).json({
      id: row.id,
      dueAt: row.due_at,
      createdAt: row.created_at,
    });
  },
);

router.patch(
  "/patients/:id/followups/:fid/complete",
  requireAdmin,
  adminWriteRateLimiter,
  async (req, res) => {
    const parsed = patientIdParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = parsed.data;

    const fIdCheck = followupIdParam.safeParse(req.params.fid);
    if (!fIdCheck.success) {
      res.status(400).json({ error: "invalid_followup_id" });
      return;
    }
    const followupId = fIdCheck.data;

    const supabase = getSupabaseServiceRoleClient();

    const { data: row } = await supabase
      .schema("resupply")
      .from("patient_followups")
      .select("id, patient_id, completed_at, body, due_at")
      .eq("id", followupId)
      .limit(1)
      .maybeSingle();
    if (!row) {
      res.status(404).json({ error: "followup_not_found" });
      return;
    }
    if (row.patient_id !== patientId) {
      res.status(404).json({ error: "followup_not_found" });
      return;
    }
    if (row.completed_at !== null) {
      res.status(409).json({
        error: "already_completed",
        message: "This followup is already marked complete.",
      });
      return;
    }

    const { data: updatedRow, error } = await supabase
      .schema("resupply")
      .from("patient_followups")
      .update({
        completed_at: new Date().toISOString(),
        completed_by_email: req.adminEmail ?? "<unknown>",
        completed_by_user_id: req.adminUserId ?? null,
      })
      .eq("id", followupId)
      .eq("patient_id", patientId)
      .is("completed_at", null)
      .select("id, completed_at")
      .maybeSingle();
    if (error) throw error;
    if (!updatedRow) {
      res.status(409).json({
        error: "already_completed",
        message: "This followup is already marked complete.",
      });
      return;
    }

    await logAudit({
      action: "patient.followup.complete",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_followups",
      targetId: followupId,
      metadata: {
        patient_id: patientId,
        body_length: row.body.length,
        due_at: row.due_at,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.followup.complete audit write failed");
    });

    res.json({
      id: updatedRow.id,
      completedAt: updatedRow.completed_at,
    });
  },
);

export default router;
