// /admin/compliance/training-records — staff training records for
// the accreditation binder.
//
//   GET   /admin/compliance/training-records           — list with
//                                                         expiry buckets
//   POST  /admin/compliance/training-records           — record a
//                                                         completed training
//   PATCH /admin/compliance/training-records/:id       — narrow updates
//                                                         (notes, evidence)
//
// Identity fields (staff_user_id, training_type, completed_at) are
// immutable post-create — to "edit" a mistake, retire and re-add.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
  TRAINING_TYPE_VALUES,
} from "@workspace/resupply-db";

import { bucketizeTrainingExpiry } from "../../lib/compliance/training-expiry";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

type StaffTrainingUpdate =
  Database["resupply"]["Tables"]["staff_training_records"]["Update"];

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const idParam = z.object({ id: z.string().uuid() });

const createBody = z
  .object({
    staffUserId: z.string().uuid(),
    trainingType: z.enum(TRAINING_TYPE_VALUES),
    courseTitle: z.string().trim().max(200).nullable().optional(),
    completedAt: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    expiresAt: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    creditHours: z.number().min(0).max(1000).nullable().optional(),
    provider: z.string().trim().max(120).nullable().optional(),
    certificateReference: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    notes: z.string().trim().max(2000).nullable().optional(),
    provider: z.string().trim().max(120).nullable().optional(),
    certificateReference: z.string().trim().max(120).nullable().optional(),
    expiresAt: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
  })
  .strict();

router.get(
  "/admin/compliance/training-records",
  // Per-staff training-record roster. `training.manage` is the
  // catalog's training-domain perm — held by admin / supervisor /
  // compliance_officer. Tightens out csr / fitter / fulfillment /
  // agent (HR/compliance domain; not in operational workflows).
  requirePermission("training.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("staff_training_records")
      .select(
        "id, staff_user_id, training_type, course_title, completed_at, expires_at, credit_hours, provider, certificate_reference, notes, created_at, updated_at",
      )
      // Order by soonest expiry first so the dashboard's
      // "due-soon" rows surface at the top without client-side sort.
      .order("expires_at", { ascending: true, nullsFirst: false });
    if (error) throw error;

    const asOfDate = new Date().toISOString().slice(0, 10);
    res.json({
      asOfDate,
      records: (data ?? []).map((r) => ({
        id: r.id,
        staffUserId: r.staff_user_id,
        trainingType: r.training_type,
        courseTitle: r.course_title,
        completedAt: r.completed_at,
        expiresAt: r.expires_at,
        // PostgREST returns numeric as string — keep that contract,
        // the SPA parses for display.
        creditHours: r.credit_hours,
        provider: r.provider,
        certificateReference: r.certificate_reference,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        expiryBucket: bucketizeTrainingExpiry({
          expiresAt: r.expires_at,
          asOfDate,
        }),
      })),
    });
  },
);

router.post(
  "/admin/compliance/training-records",
  requirePermission("training.manage"),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
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
    const b = parsed.data;
    if (b.expiresAt && b.expiresAt < b.completedAt) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "expiresAt",
            message: "Expiry cannot precede completion date.",
          },
        ],
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("staff_training_records")
      .insert({
        staff_user_id: b.staffUserId,
        training_type: b.trainingType,
        course_title: b.courseTitle ?? null,
        completed_at: b.completedAt,
        expires_at: b.expiresAt ?? null,
        credit_hours:
          b.creditHours == null ? null : b.creditHours.toString(),
        provider: b.provider ?? null,
        certificate_reference: b.certificateReference ?? null,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "compliance.training.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "staff_training_records",
      targetId: row.id,
      // Staff training is HR data, not PHI — safe to include the
      // staff user id + training type in the audit envelope.
      metadata: {
        staff_user_id: b.staffUserId,
        training_type: b.trainingType,
        completed_at: b.completedAt,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.training.create audit failed");
    });

    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/compliance/training-records/:id",
  requirePermission("training.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }
    const updates: StaffTrainingUpdate = {};
    if (fields.notes !== undefined) updates.notes = fields.notes;
    if (fields.provider !== undefined) updates.provider = fields.provider;
    if (fields.certificateReference !== undefined)
      updates.certificate_reference = fields.certificateReference;
    if (fields.expiresAt !== undefined) updates.expires_at = fields.expiresAt;

    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("staff_training_records")
      .update(updates)
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "compliance.training.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "staff_training_records",
      targetId: params.data.id,
      metadata: {
        updated_fields: Object.keys(fields),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.training.update audit failed");
    });
    res.status(200).json({ id: params.data.id, changed: true });
  },
);

export default router;
