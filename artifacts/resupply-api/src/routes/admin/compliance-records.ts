// /admin/compliance/* — catch-all CRUD for the registers that need
// a flat list + create + narrow update surface but do not warrant
// their own dedicated route file:
//
//   risk-assessments        — HIPAA §164.308(a)(1)(ii)(A) annual.
//   contingency-attestations — §164.308(a)(7) plan attestations.
//   disaster-drills         — §164.308(a)(7) preparedness drills.
//   qi-initiatives          — ACHC QAPI program initiatives.
//   qi-measurements         — per-initiative quarterly measurements.
//   ownership-disclosures   — §424.57(c)(17) supplier ownership.
//   disclosure-log          — §164.528 accounting entries (admin-side
//                              record of disclosures the org makes).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  DISCLOSURE_PURPOSE_VALUES,
  DRILL_KIND_VALUES,
  getSupabaseServiceRoleClient,
  HIPAA_RISK_METHODOLOGY_VALUES,
  OWNERSHIP_PERSON_ROLE_VALUES,
  QI_CATEGORY_VALUES,
  QI_STATUS_VALUES,
} from "@workspace/resupply-db";

import { logDisclosure } from "../../lib/compliance/disclosure-logger";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9_-]+$/;

// ─────────────────────────────────────────────────────────────────
// Risk assessments
// ─────────────────────────────────────────────────────────────────

const riskCreate = z
  .object({
    assessmentYear: z.number().int().min(2020).max(2099),
    methodology: z.enum(HIPAA_RISK_METHODOLOGY_VALUES),
    vendorName: z.string().trim().max(200).nullable().optional(),
    scopeSummary: z.string().trim().min(1).max(8000),
    findings: z.record(z.string(), z.unknown()).optional(),
    remediationPlan: z.string().trim().max(16000).nullable().optional(),
    executiveSummary: z.string().trim().max(8000).nullable().optional(),
    completedOn: z.string().regex(ISO_DATE),
    reportDocumentObjectKey: z.string().trim().max(400).nullable().optional(),
    ownerEmail: z.string().trim().email().max(180),
  })
  .strict();

router.get(
  "/admin/compliance/risk-assessments",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("hipaa_risk_assessments")
      .select("*")
      .order("assessment_year", { ascending: false });
    if (error) throw error;
    res.json({ assessments: data ?? [] });
  },
);

router.post(
  "/admin/compliance/risk-assessments",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.risk_assessments.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = riskCreate.safeParse(req.body);
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
      .from("hipaa_risk_assessments")
      .insert({
        assessment_year: b.assessmentYear,
        methodology: b.methodology,
        vendor_name: b.vendorName ?? null,
        scope_summary: b.scopeSummary,
        findings_json: (b.findings ?? {}) as Database["resupply"]["Tables"]["hipaa_risk_assessments"]["Row"]["findings_json"],
        remediation_plan: b.remediationPlan ?? null,
        executive_summary: b.executiveSummary ?? null,
        completed_on: b.completedOn,
        report_document_object_key: b.reportDocumentObjectKey ?? null,
        owner_email: b.ownerEmail,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "duplicate_year" });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "compliance.risk_assessment.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "hipaa_risk_assessments",
      targetId: row.id,
      metadata: { assessment_year: b.assessmentYear },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "risk_assessment.create audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

// ─────────────────────────────────────────────────────────────────
// Contingency plan attestations
// ─────────────────────────────────────────────────────────────────

const contingencyCreate = z
  .object({
    planVersion: z.string().trim().min(1).max(40),
    planDocumentObjectKey: z.string().trim().max(400).nullable().optional(),
    documentedRtoHours: z.number().int().min(1).max(720).optional(),
    documentedRpoHours: z.number().int().min(0).max(720).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/compliance/contingency-attestations",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("contingency_plan_attestations")
      .select("*")
      .order("attested_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ attestations: data ?? [] });
  },
);

router.post(
  "/admin/compliance/contingency-attestations",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.contingency_attestations.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = contingencyCreate.safeParse(req.body);
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
      .from("contingency_plan_attestations")
      .insert({
        plan_version: b.planVersion,
        plan_document_object_key: b.planDocumentObjectKey ?? null,
        attested_by_email: req.adminEmail ?? "unknown",
        documented_rto_hours: b.documentedRtoHours ?? 72,
        documented_rpo_hours: b.documentedRpoHours ?? 24,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "compliance.contingency_attestation.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "contingency_plan_attestations",
      targetId: row.id,
      metadata: { plan_version: b.planVersion },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "contingency_attestation.create audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

// ─────────────────────────────────────────────────────────────────
// Disaster preparedness drills
// ─────────────────────────────────────────────────────────────────

const drillCreate = z
  .object({
    drillKind: z.enum(DRILL_KIND_VALUES),
    scenario: z.string().trim().min(1).max(2000),
    executedOn: z.string().regex(ISO_DATE),
    rtoTargetHours: z.number().int().min(0).max(720).nullable().optional(),
    rtoActualHours: z.number().int().min(0).max(720).nullable().optional(),
    participantsCount: z.number().int().min(0).max(1000).nullable().optional(),
    outcome: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

router.get(
  "/admin/compliance/disaster-drills",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("disaster_preparedness_drills")
      .select("*")
      .order("executed_on", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ drills: data ?? [] });
  },
);

router.post(
  "/admin/compliance/disaster-drills",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.disaster_drills.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = drillCreate.safeParse(req.body);
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
      .from("disaster_preparedness_drills")
      .insert({
        drill_kind: b.drillKind,
        scenario: b.scenario,
        executed_on: b.executedOn,
        rto_target_hours: b.rtoTargetHours ?? null,
        rto_actual_hours: b.rtoActualHours ?? null,
        participants_count: b.participantsCount ?? null,
        outcome_json: (b.outcome ?? {}) as Database["resupply"]["Tables"]["disaster_preparedness_drills"]["Row"]["outcome_json"],
        lead_email: req.adminEmail ?? "unknown",
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "compliance.disaster_drill.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "disaster_preparedness_drills",
      targetId: row.id,
      metadata: { drill_kind: b.drillKind, executed_on: b.executedOn },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "disaster_drill.create audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

// ─────────────────────────────────────────────────────────────────
// QI initiatives + measurements (ACHC QAPI)
// ─────────────────────────────────────────────────────────────────

const qiCreate = z
  .object({
    slug: z.string().trim().min(1).max(80).regex(SLUG_RE),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(8000),
    category: z.enum(QI_CATEGORY_VALUES),
    targetMetric: z.string().trim().min(1).max(240),
    baselineMetric: z.string().trim().max(240).nullable().optional(),
    ownerEmail: z.string().trim().email().max(180),
    startedOn: z.string().regex(ISO_DATE),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/compliance/qi-initiatives",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("quality_improvement_initiatives")
      .select("*")
      .order("status", { ascending: true })
      .order("started_on", { ascending: false });
    if (error) throw error;
    res.json({ initiatives: data ?? [] });
  },
);

router.post(
  "/admin/compliance/qi-initiatives",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.qi_initiatives.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = qiCreate.safeParse(req.body);
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
      .from("quality_improvement_initiatives")
      .insert({
        slug: b.slug,
        title: b.title,
        description: b.description,
        category: b.category,
        target_metric: b.targetMetric,
        baseline_metric: b.baselineMetric ?? null,
        owner_email: b.ownerEmail,
        started_on: b.startedOn,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "duplicate_slug" });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "compliance.qi_initiative.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "quality_improvement_initiatives",
      targetId: row.id,
      metadata: { slug: b.slug, category: b.category },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "qi_initiative.create audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

const qiPatch = z
  .object({
    status: z.enum(QI_STATUS_VALUES).optional(),
    concludedOn: z.string().regex(ISO_DATE).nullable().optional(),
    annualEvaluationSummary: z.string().trim().max(8000).nullable().optional(),
    annualEvaluationCompletedOn: z
      .string()
      .regex(ISO_DATE)
      .nullable()
      .optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.patch(
  "/admin/compliance/qi-initiatives/:id",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.qi_initiatives.update", preset: "mutation" }),
  async (req, res) => {
    const params = z
      .object({ id: z.string().uuid() })
      .safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = qiPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("quality_improvement_initiatives")
      .update({
        ...(fields.status !== undefined ? { status: fields.status } : {}),
        ...(fields.concludedOn !== undefined
          ? { concluded_on: fields.concludedOn }
          : {}),
        ...(fields.annualEvaluationSummary !== undefined
          ? { annual_evaluation_summary: fields.annualEvaluationSummary }
          : {}),
        ...(fields.annualEvaluationCompletedOn !== undefined
          ? {
              annual_evaluation_completed_on:
                fields.annualEvaluationCompletedOn,
            }
          : {}),
        ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json({ id: params.data.id, changed: true });
  },
);

const measurementCreate = z
  .object({
    initiativeId: z.string().uuid(),
    periodStart: z.string().regex(ISO_DATE),
    periodEnd: z.string().regex(ISO_DATE),
    metricValue: z.string().trim().min(1).max(240),
    studyFindings: z.string().trim().max(4000).nullable().optional(),
    actCorrectiveActions: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/compliance/qi-initiatives/:id/measurements",
  requirePermission("compliance.read"),
  async (req, res) => {
    const params = z
      .object({ id: z.string().uuid() })
      .safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("quality_improvement_measurements")
      .select("*")
      .eq("initiative_id", params.data.id)
      .order("period_end", { ascending: false });
    if (error) throw error;
    res.json({ measurements: data ?? [] });
  },
);

router.post(
  "/admin/compliance/qi-measurements",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.qi_measurements.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = measurementCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    if (b.periodEnd < b.periodStart) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "periodEnd",
            message: "periodEnd cannot precede periodStart",
          },
        ],
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("quality_improvement_measurements")
      .insert({
        initiative_id: b.initiativeId,
        period_start: b.periodStart,
        period_end: b.periodEnd,
        metric_value: b.metricValue,
        study_findings: b.studyFindings ?? null,
        act_corrective_actions: b.actCorrectiveActions ?? null,
        recorded_by_email: req.adminEmail ?? "unknown",
      })
      .select("id")
      .single();
    if (error) throw error;
    res.status(201).json({ id: data.id });
  },
);

// ─────────────────────────────────────────────────────────────────
// DME ownership disclosures
// ─────────────────────────────────────────────────────────────────

const ownershipCreate = z
  .object({
    organizationId: z.string().uuid(),
    personLegalName: z.string().trim().min(1).max(200),
    personRole: z.enum(OWNERSHIP_PERSON_ROLE_VALUES),
    ownershipPct: z.number().min(0).max(100).nullable().optional(),
    relatedProviderDisclosed: z.boolean().optional(),
    relatedProviderDescription: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional(),
    ssnLast4: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .optional(),
    taxId: z
      .string()
      .regex(/^\d{9}$/)
      .nullable()
      .optional(),
    disclosedOn: z.string().regex(ISO_DATE),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/compliance/ownership-disclosures",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("dme_ownership_disclosures")
      .select("*")
      .is("removed_on", null)
      .order("disclosed_on", { ascending: false });
    if (error) throw error;
    res.json({ disclosures: data ?? [] });
  },
);

router.post(
  "/admin/compliance/ownership-disclosures",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.ownership_disclosures.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = ownershipCreate.safeParse(req.body);
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
      .from("dme_ownership_disclosures")
      .insert({
        organization_id: b.organizationId,
        person_legal_name: b.personLegalName,
        person_role: b.personRole,
        ownership_pct: b.ownershipPct ?? null,
        related_provider_disclosed: b.relatedProviderDisclosed ?? false,
        related_provider_description: b.relatedProviderDescription ?? null,
        ssn_last4: b.ssnLast4 ?? null,
        tax_id: b.taxId ?? null,
        disclosed_on: b.disclosedOn,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "compliance.ownership_disclosure.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dme_ownership_disclosures",
      targetId: row.id,
      metadata: {
        organization_id: b.organizationId,
        person_role: b.personRole,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "ownership_disclosure.create audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

router.delete(
  "/admin/compliance/ownership-disclosures/:id",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.ownership_disclosures.delete", preset: "destroy" }),
  async (req, res) => {
    const params = z
      .object({ id: z.string().uuid() })
      .safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("dme_ownership_disclosures")
      .update({
        removed_on: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.data.id)
      .is("removed_on", null)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await logAudit({
      action: "compliance.ownership_disclosure.remove",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dme_ownership_disclosures",
      targetId: params.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "ownership_disclosure.remove audit failed");
    });
    res.status(204).end();
  },
);

// ─────────────────────────────────────────────────────────────────
// Disclosure log (admin-side §164.528 entry)
// ─────────────────────────────────────────────────────────────────

const disclosureCreate = z
  .object({
    patientId: z.string().uuid(),
    recipientName: z.string().trim().min(1).max(200),
    recipientAddress: z.string().trim().max(2000).nullable().optional(),
    purpose: z.enum(DISCLOSURE_PURPOSE_VALUES),
    description: z.string().trim().min(1).max(4000),
    legalAuthority: z.string().trim().max(2000).nullable().optional(),
    patientAuthorized: z.boolean().optional(),
    disclosedAt: z.string().datetime().optional(),
  })
  .strict();

router.post(
  "/admin/compliance/disclosure-log",
  requirePermission("compliance.resolve"),
  adminRateLimit({ name: "compliance.disclosure_log.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = disclosureCreate.safeParse(req.body);
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
    const { id } = await logDisclosure({
      patientId: b.patientId,
      recipientName: b.recipientName,
      recipientAddress: b.recipientAddress ?? null,
      purpose: b.purpose,
      description: b.description,
      legalAuthority: b.legalAuthority ?? null,
      patientAuthorized: b.patientAuthorized ?? false,
      disclosedAt: b.disclosedAt ? new Date(b.disclosedAt) : undefined,
      disclosedByEmail: req.adminEmail ?? "unknown",
    });
    await logAudit({
      action: "compliance.disclosure.log",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_disclosure_log",
      targetId: id,
      // PHI containment: identify the patient + purpose only.
      metadata: {
        patient_id: b.patientId,
        purpose: b.purpose,
        patient_authorized: b.patientAuthorized ?? false,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "disclosure.log audit failed");
    });
    res.status(201).json({ id });
  },
);

router.get(
  "/admin/compliance/patients/:patientId/disclosure-log",
  requirePermission("compliance.read"),
  async (req, res) => {
    const params = z
      .object({ patientId: z.string().uuid() })
      .safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_disclosure_log")
      .select("*")
      .eq("patient_id", params.data.patientId)
      .order("disclosed_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({ entries: data ?? [] });
  },
);

export default router;
