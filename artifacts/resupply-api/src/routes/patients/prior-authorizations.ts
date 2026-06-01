// /patients/:id/prior-authorizations — payer auths to dispense a
// specific HCPCS for a specific patient.
//
//   GET    /patients/:id/prior-authorizations         — list newest-first
//   POST   /patients/:id/prior-authorizations         — record / draft
//   PATCH  /patients/:id/prior-authorizations/:paId   — status transitions
//                                                        and field updates
//
// Status state machine
// --------------------
//   draft     -> submitted | (delete by replacing with new row)
//   submitted -> approved | denied
//   denied    -> appealed
//   appealed  -> approved | denied
//   approved  -> expired         (via the daily sweep, not the API)
//
// Capture-only in this Tier-2a sprint. Tier-2b will add automated
// submission to the payers that expose APIs.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type PriorAuthorizationUpdate =
  Database["resupply"]["Tables"]["prior_authorizations"]["Update"];

import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HCPCS_RE = /^[A-Z]\d{4}(-[A-Z0-9]{2}){0,4}$/;

const idParam = z.object({ id: z.string().uuid() });
const idAndPaParam = z.object({
  id: z.string().uuid(),
  paId: z.string().uuid(),
});

const STATUS_VALUES = [
  "draft",
  "submitted",
  "approved",
  "denied",
  "appealed",
  "expired",
] as const;

// Allowed status transitions; expired is set by a daily sweep, not
// by the API.
const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["submitted"],
  submitted: ["approved", "denied"],
  denied: ["appealed"],
  appealed: ["approved", "denied"],
  // approved has no forward transition through the API — expiry is
  // automatic from approved_through.
  approved: [],
  expired: [],
};

const createBody = z
  .object({
    insuranceCoverageId: z.string().uuid().nullable().optional(),
    hcpcsCode: z
      .string()
      .trim()
      .max(12)
      .transform((v) => v.toUpperCase())
      .refine((v) => HCPCS_RE.test(v), "must be a HCPCS code like E0601"),
    payerName: z.string().trim().min(1).max(120),
    authNumber: z.string().trim().max(64).nullable().optional(),
    status: z.enum(STATUS_VALUES).default("draft"),
    requestedAt: z.string().datetime().nullable().optional(),
    submittedAt: z.string().datetime().nullable().optional(),
    decisionAt: z.string().datetime().nullable().optional(),
    approvedThrough: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    denialReason: z.string().trim().max(2000).nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    // Status transitions are validated against VALID_TRANSITIONS.
    status: z.enum(STATUS_VALUES).optional(),
    authNumber: z.string().trim().max(64).nullable().optional(),
    submittedAt: z.string().datetime().nullable().optional(),
    decisionAt: z.string().datetime().nullable().optional(),
    approvedThrough: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    denialReason: z.string().trim().max(2000).nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.get(
  "/patients/:id/prior-authorizations",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select(
        "id, insurance_coverage_id, hcpcs_code, payer_name, auth_number, status, requested_at, submitted_at, decision_at, approved_through, denial_reason, document_id, notes, created_at, updated_at",
      )
      .eq("patient_id", idParsed.data.id)
      .order("created_at", { ascending: false });
    if (error) throw error;

    res.json({
      priorAuthorizations: (data ?? []).map((r) => ({
        id: r.id,
        insuranceCoverageId: r.insurance_coverage_id,
        hcpcsCode: r.hcpcs_code,
        payerName: r.payer_name,
        authNumber: r.auth_number,
        status: r.status,
        requestedAt: r.requested_at,
        submittedAt: r.submitted_at,
        decisionAt: r.decision_at,
        approvedThrough: r.approved_through,
        denialReason: r.denial_reason,
        documentId: r.document_id,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.post(
  "/patients/:id/prior-authorizations",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
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
    const supabase = getSupabaseServiceRoleClient();

    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .insert({
        patient_id: idParsed.data.id,
        insurance_coverage_id: b.insuranceCoverageId ?? null,
        hcpcs_code: b.hcpcsCode,
        payer_name: b.payerName,
        auth_number: b.authNumber ?? null,
        status: b.status,
        requested_at: b.requestedAt ?? null,
        submitted_at: b.submittedAt ?? null,
        decision_at: b.decisionAt ?? null,
        approved_through: b.approvedThrough ?? null,
        denial_reason: b.denialReason ?? null,
        document_id: b.documentId ?? null,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "patient.prior_authorization.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prior_authorizations",
      targetId: row.id,
      metadata: {
        patient_id: idParsed.data.id,
        hcpcs_code: b.hcpcsCode,
        payer_name: b.payerName,
        status: b.status,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.prior_authorization.create audit write failed",
      );
    });

    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/patients/:id/prior-authorizations/:paId",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndPaParam.safeParse(req.params);
    if (!idParsed.success) {
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

    const supabase = getSupabaseServiceRoleClient();

    // If status is changing, validate the transition.
    if (fields.status !== undefined) {
      const { data: existing } = await supabase
        .schema("resupply")
        .from("prior_authorizations")
        .select("status")
        .eq("id", idParsed.data.paId)
        .eq("patient_id", idParsed.data.id)
        .limit(1)
        .maybeSingle();
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const fromStatus = existing.status;
      const toStatus = fields.status;
      if (fromStatus === toStatus) {
        // No-op same-status transition is allowed (matches the
        // pattern in prescriptions-update.ts).
      } else if (!VALID_TRANSITIONS[fromStatus]?.includes(toStatus)) {
        res.status(400).json({
          error: "invalid_transition",
          message: `Cannot transition prior authorization from "${fromStatus}" to "${toStatus}".`,
        });
        return;
      }
    }

    const updates: PriorAuthorizationUpdate = {};
    if (fields.status !== undefined) updates.status = fields.status;
    if (fields.authNumber !== undefined)
      updates.auth_number = fields.authNumber;
    if (fields.submittedAt !== undefined)
      updates.submitted_at = fields.submittedAt;
    if (fields.decisionAt !== undefined)
      updates.decision_at = fields.decisionAt;
    if (fields.approvedThrough !== undefined)
      updates.approved_through = fields.approvedThrough;
    if (fields.denialReason !== undefined)
      updates.denial_reason = fields.denialReason;
    if (fields.documentId !== undefined)
      updates.document_id = fields.documentId;
    if (fields.notes !== undefined) updates.notes = fields.notes;

    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .update(updates)
      .eq("id", idParsed.data.paId)
      .eq("patient_id", idParsed.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "patient.prior_authorization.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prior_authorizations",
      targetId: idParsed.data.paId,
      metadata: {
        patient_id: idParsed.data.id,
        updated_fields: Object.keys(fields),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.prior_authorization.update audit write failed",
      );
    });

    res.status(200).json({ id: idParsed.data.paId, changed: true });
  },
);

export default router;
