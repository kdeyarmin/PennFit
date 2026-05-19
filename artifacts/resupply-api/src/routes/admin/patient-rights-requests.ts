// /admin/compliance/patient-rights-requests — admin workflow for
// HIPAA §164.522/524/526/528 rights requests.
//
//   GET   /admin/compliance/patient-rights-requests
//         — open queue + due-soon bucketization
//   GET   /admin/compliance/patient-rights-requests/:id
//         — single request detail
//   POST  /admin/compliance/patient-rights-requests
//         — record a request received by phone/mail/in-person
//           (patient-portal-submitted ones land via the /api/me route).
//   PATCH /admin/compliance/patient-rights-requests/:id
//         — narrow updates: status, extension_granted_at, decision,
//           decision_rationale, response document key, delivered_at.
//
// 30-day clock per §164.524(b)(2). The bucketize helper surfaces
// "extension_eligible" once the first 30 days lapse; the operator
// then PATCHes extension_granted_at to start the second window.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
  PATIENT_RIGHTS_DECISION_VALUES,
  PATIENT_RIGHTS_KIND_VALUES,
  PATIENT_RIGHTS_STATUS_VALUES,
  PATIENT_RIGHTS_SUBMITTED_VIA_VALUES,
} from "@workspace/resupply-db";

import {
  bucketizeRightsClock,
  computeDueByIso,
} from "../../lib/compliance/patient-rights-clock";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

type RightsUpdate =
  Database["resupply"]["Tables"]["patient_rights_requests"]["Update"];

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const createBody = z
  .object({
    patientId: z.string().uuid(),
    requestKind: z.enum(PATIENT_RIGHTS_KIND_VALUES),
    submittedVia: z.enum(PATIENT_RIGHTS_SUBMITTED_VIA_VALUES),
    requestBody: z.string().trim().min(1).max(8000),
    requestDetails: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const patchBody = z
  .object({
    status: z.enum(PATIENT_RIGHTS_STATUS_VALUES).optional(),
    extensionGrantedAt: z.string().datetime().nullable().optional(),
    decision: z.enum(PATIENT_RIGHTS_DECISION_VALUES).nullable().optional(),
    decisionRationale: z.string().trim().max(8000).nullable().optional(),
    responseDocumentObjectKey: z.string().trim().max(400).nullable().optional(),
    deliveredAt: z.string().datetime().nullable().optional(),
  })
  .strict();

router.get(
  "/admin/compliance/patient-rights-requests",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_rights_requests")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const asOf = new Date().toISOString();
    res.json({
      asOf,
      requests: (data ?? []).map((row) => ({
        ...row,
        due_by: computeDueByIso(row.received_at, row.extension_granted_at),
        clock_bucket: bucketizeRightsClock({
          receivedAt: row.received_at,
          extensionGrantedAt: row.extension_granted_at,
          status: row.status,
          asOf,
        }),
      })),
    });
  },
);

router.get(
  "/admin/compliance/patient-rights-requests/:id",
  requirePermission("compliance.read"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_rights_requests")
      .select("*")
      .eq("id", params.data.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const asOf = new Date().toISOString();
    res.json({
      ...data,
      due_by: computeDueByIso(data.received_at, data.extension_granted_at),
      clock_bucket: bucketizeRightsClock({
        receivedAt: data.received_at,
        extensionGrantedAt: data.extension_granted_at,
        status: data.status,
        asOf,
      }),
    });
  },
);

router.post(
  "/admin/compliance/patient-rights-requests",
  requirePermission("compliance.resolve"),
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_rights_requests")
      .insert({
        patient_id: b.patientId,
        request_kind: b.requestKind,
        submitted_via: b.submittedVia,
        request_body: b.requestBody,
        request_details_json: (b.requestDetails ?? {}) as Database["resupply"]["Tables"]["patient_rights_requests"]["Row"]["request_details_json"],
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "compliance.patient_rights.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_rights_requests",
      targetId: row.id,
      // PHI here is the request kind + the patient id (acceptable
      // for audit); do NOT echo the request body in the metadata.
      metadata: {
        patient_id: b.patientId,
        request_kind: b.requestKind,
        submitted_via: b.submittedVia,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.patient_rights.create audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/compliance/patient-rights-requests/:id",
  requirePermission("compliance.resolve"),
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
    const updates: RightsUpdate = { updated_at: new Date().toISOString() };
    if (fields.status !== undefined) updates.status = fields.status;
    if (fields.extensionGrantedAt !== undefined)
      updates.extension_granted_at = fields.extensionGrantedAt;
    if (fields.decision !== undefined) updates.decision = fields.decision;
    if (fields.decisionRationale !== undefined)
      updates.decision_rationale = fields.decisionRationale;
    if (fields.responseDocumentObjectKey !== undefined)
      updates.response_document_object_key =
        fields.responseDocumentObjectKey;
    if (fields.deliveredAt !== undefined)
      updates.delivered_at = fields.deliveredAt;
    // If a decision is being recorded and there's no decided_at yet,
    // stamp now + email so the SLA closure is captured atomically.
    if (
      fields.decision !== undefined &&
      fields.decision !== null
    ) {
      updates.decided_at = new Date().toISOString();
      updates.decided_by_email = req.adminEmail ?? "unknown";
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_rights_requests")
      .update(updates)
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await logAudit({
      action: "compliance.patient_rights.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_rights_requests",
      targetId: params.data.id,
      metadata: { updated_fields: Object.keys(fields) },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.patient_rights.update audit failed");
    });
    res.status(200).json({ id: params.data.id, changed: true });
  },
);

export default router;
