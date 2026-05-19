// /admin/accreditation/surveys — track scheduled + completed surveys.
//
//   GET   /admin/accreditation/surveys
//   POST  /admin/accreditation/surveys       admin-only
//   PATCH /admin/accreditation/surveys/:id   admin-only

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdmin,
  requireAdminOnly,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["accreditation_surveys"]["Row"];

const BODY_VALUES = ["achc", "boc", "tjc", "cap", "other"] as const satisfies readonly Row["accreditation_body"][];
const TYPE_VALUES = [
  "initial",
  "renewal",
  "annual_unannounced",
  "change_of_ownership",
  "complaint_driven",
  "projected",
] as const satisfies readonly Row["survey_type"][];
const OUTCOME_VALUES = [
  "passed",
  "passed_with_findings",
  "failed",
  "pending",
] as const satisfies readonly NonNullable<Row["outcome"]>[];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const upsertBody = z
  .object({
    accreditationBody: z.enum(BODY_VALUES),
    surveyType: z.enum(TYPE_VALUES),
    scheduledFor: z.string().regex(ISO_DATE_RE).nullable().optional(),
    completedOn: z.string().regex(ISO_DATE_RE).nullable().optional(),
    outcome: z.enum(OUTCOME_VALUES).nullable().optional(),
    findingsCount: z.number().int().min(0).default(0),
    correctiveActionDueOn: z.string().regex(ISO_DATE_RE).nullable().optional(),
    correctiveActionCompletedOn: z.string().regex(ISO_DATE_RE).nullable().optional(),
    surveyorName: z.string().trim().max(160).nullable().optional(),
    reportDocumentObjectKey: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();
const patchBody = upsertBody.partial();
const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: Row) {
  return {
    id: r.id,
    organizationId: r.organization_id,
    accreditationBody: r.accreditation_body,
    surveyType: r.survey_type,
    scheduledFor: r.scheduled_for,
    completedOn: r.completed_on,
    outcome: r.outcome,
    findingsCount: r.findings_count,
    correctiveActionDueOn: r.corrective_action_due_on,
    correctiveActionCompletedOn: r.corrective_action_completed_on,
    surveyorName: r.surveyor_name,
    reportDocumentObjectKey: r.report_document_object_key,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/accreditation/surveys",
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("accreditation_surveys")
      .select("*")
      .order("scheduled_for", { ascending: false, nullsFirst: false })
      .limit(100);
    if (error) throw error;
    res.json({ surveys: (data ?? []).map(rowToApi) });
  },
);

router.post(
  "/admin/accreditation/surveys",
  requireAdminOnly,
  async (req, res) => {
    const parsed = upsertBody.safeParse(req.body);
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
    const { data: org } = await supabase
      .schema("resupply")
      .from("dme_organization")
      .select("id")
      .eq("singleton", true)
      .limit(1)
      .maybeSingle();
    if (!org) {
      res.status(409).json({
        error: "no_organization",
        message: "configure dme_organization first",
      });
      return;
    }
    const b = parsed.data;
    const { data, error } = await supabase
      .schema("resupply")
      .from("accreditation_surveys")
      .insert({
        organization_id: org.id,
        accreditation_body: b.accreditationBody,
        survey_type: b.surveyType,
        scheduled_for: b.scheduledFor ?? null,
        completed_on: b.completedOn ?? null,
        outcome: b.outcome ?? null,
        findings_count: b.findingsCount,
        corrective_action_due_on: b.correctiveActionDueOn ?? null,
        corrective_action_completed_on: b.correctiveActionCompletedOn ?? null,
        surveyor_name: b.surveyorName ?? null,
        report_document_object_key: b.reportDocumentObjectKey ?? null,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "accreditation_survey.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "accreditation_surveys",
      targetId: data.id,
      metadata: { body: b.accreditationBody, type: b.surveyType },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "accreditation_survey.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/accreditation/surveys/:id",
  requireAdminOnly,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
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
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["accreditation_surveys"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.accreditationBody !== undefined) update.accreditation_body = b.accreditationBody;
    if (b.surveyType !== undefined) update.survey_type = b.surveyType;
    if (b.scheduledFor !== undefined) update.scheduled_for = b.scheduledFor;
    if (b.completedOn !== undefined) update.completed_on = b.completedOn;
    if (b.outcome !== undefined) update.outcome = b.outcome;
    if (b.findingsCount !== undefined) update.findings_count = b.findingsCount;
    if (b.correctiveActionDueOn !== undefined)
      update.corrective_action_due_on = b.correctiveActionDueOn;
    if (b.correctiveActionCompletedOn !== undefined)
      update.corrective_action_completed_on = b.correctiveActionCompletedOn;
    if (b.surveyorName !== undefined) update.surveyor_name = b.surveyorName;
    if (b.reportDocumentObjectKey !== undefined)
      update.report_document_object_key = b.reportDocumentObjectKey;
    if (b.notes !== undefined) update.notes = b.notes;

    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("accreditation_surveys")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "accreditation_survey.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "accreditation_surveys",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "accreditation_survey.update audit write failed");
    });
    res.json({ ok: true });
  },
);

export default router;
