// Medicare ADR / audit-response queue.
//
//   GET   /admin/billing/adr-worklist          — open ADRs, soonest deadline
//   POST  /admin/billing/adr                    — log a new ADR (+ seed checklist)
//   GET   /admin/billing/adr/:id                — detail + document checklist
//   PATCH /admin/billing/adr/:id                — status / outcome / submit / notes
//
// Gated behind the billing.adr_queue feature flag. The SLA status (on_track /
// at_risk / overdue / decided) is derived from the response deadline with the
// shared pure classifier so the worklist, the sweep, and the UI all agree.
// Operational deadline tracking — no audit_log writes; PHI stays out of logs.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";
import {
  AUDIT_PACKET_CATALOG,
  type AuditScope,
  assessAuditReadiness,
  classifyAdrSla,
  defaultSelection,
  getAuditPacketItem,
} from "@workspace/resupply-domain";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const SOURCES = [
  "rac",
  "cert",
  "tpe",
  "upic",
  "payer_medical_review",
  "other",
] as const;
const SCOPES = ["device", "supplies", "both"] as const;
const RECEIVED_VIA = [
  "inbound_fax",
  "mail",
  "portal",
  "email",
  "manual",
] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** SLA status for a row, derived from its deadline + decided state. */
function slaFor(row: {
  response_due: string | null;
  status: string;
}): "on_track" | "at_risk" | "overdue" | "decided" {
  const decided = row.status === "submitted" || row.status === "closed";
  return classifyAdrSla(row.response_due, todayIso(), { decided }).status;
}

// ── GET worklist ────────────────────────────────────────────────────
router.get(
  "/admin/billing/adr-worklist",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("billing.adr_queue", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: rows } = await supabase
      .from("claim_adr_requests")
      .select(
        "id, patient_id, claim_id, source, contractor_name, payer_name, adr_reference, scope, received_at, response_due, status, outcome",
      )
      .in("status", ["open", "in_progress"])
      .order("response_due", { ascending: true, nullsFirst: false })
      .limit(500);
    const list = (rows ?? []) as Array<{
      id: string;
      patient_id: string;
      claim_id: string | null;
      source: string;
      contractor_name: string | null;
      payer_name: string | null;
      adr_reference: string | null;
      scope: string;
      received_at: string | null;
      response_due: string | null;
      status: string;
      outcome: string;
    }>;

    // Outstanding-doc counts, in one query.
    const ids = list.map((r) => r.id);
    const outstanding = new Map<string, number>();
    if (ids.length > 0) {
      const { data: docs } = await supabase
        .from("claim_adr_documents")
        .select("adr_id")
        .in("adr_id", ids)
        .eq("status", "outstanding");
      for (const d of (docs ?? []) as Array<{ adr_id: string }>) {
        outstanding.set(d.adr_id, (outstanding.get(d.adr_id) ?? 0) + 1);
      }
    }

    // Audit readiness per patient — which audit-critical documents are on
    // file. Fetched in one bulk query, then assessed per ADR's scope.
    const patientIds = Array.from(new Set(list.map((r) => r.patient_id)));
    const docTypesByPatient = new Map<string, Set<string>>();
    if (patientIds.length > 0) {
      const { data: pdocs } = await supabase
        .from("patient_documents")
        .select("patient_id, document_type")
        .in("patient_id", patientIds);
      for (const d of (pdocs ?? []) as Array<{
        patient_id: string;
        document_type: string;
      }>) {
        const set = docTypesByPatient.get(d.patient_id) ?? new Set<string>();
        set.add(d.document_type);
        docTypesByPatient.set(d.patient_id, set);
      }
    }
    const coveredFor = (patientId: string): string[] => {
      const types = docTypesByPatient.get(patientId) ?? new Set<string>();
      const covered: string[] = [];
      for (const item of AUDIT_PACKET_CATALOG) {
        if (item.source === "generated") covered.push(item.key);
        else if (item.documentTypes.some((t) => types.has(t)))
          covered.push(item.key);
      }
      return covered;
    };

    const items = list.map((r) => {
      const cls = classifyAdrSla(r.response_due, todayIso(), {
        decided: false,
      });
      const readiness = assessAuditReadiness(
        r.scope as AuditScope,
        coveredFor(r.patient_id),
      );
      return {
        ...r,
        slaStatus: cls.status,
        daysOut: cls.daysOut,
        outstandingDocs: outstanding.get(r.id) ?? 0,
        auditReady: readiness.ready,
        missingRequired: readiness.missing.length,
      };
    });
    res.json({
      items,
      counts: {
        total: items.length,
        atRisk: items.filter((i) => i.slaStatus === "at_risk").length,
        overdue: items.filter((i) => i.slaStatus === "overdue").length,
      },
    });
  },
);

// ── POST create ─────────────────────────────────────────────────────
const createBody = z
  .object({
    patientId: z.string().uuid(),
    claimId: z.string().uuid().nullable().optional(),
    source: z.enum(SOURCES).default("other"),
    contractorName: z.string().trim().max(200).nullable().optional(),
    payerName: z.string().trim().max(200).nullable().optional(),
    adrReference: z.string().trim().max(200).nullable().optional(),
    scope: z.enum(SCOPES).default("device"),
    receivedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    responseDue: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    receivedVia: z.enum(RECEIVED_VIA).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

router.post(
  "/admin/billing/adr",
  requirePermission("patients.update"),
  adminRateLimit({ name: "adr.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("billing.adr_queue", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Patient must exist (claim, if given, must belong to them).
    const { data: patient } = await supabase
      .from("patients")
      .select("id")
      .eq("id", parsed.data.patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (parsed.data.claimId) {
      const { data: claim } = await supabase
        .from("insurance_claims")
        .select("id, patient_id")
        .eq("id", parsed.data.claimId)
        .limit(1)
        .maybeSingle();
      if (!claim || claim.patient_id !== parsed.data.patientId) {
        res.status(404).json({ error: "claim_not_found" });
        return;
      }
    }

    const insertRow: Database["resupply"]["Tables"]["claim_adr_requests"]["Insert"] =
      {
        patient_id: parsed.data.patientId,
        claim_id: parsed.data.claimId ?? null,
        source: parsed.data.source,
        contractor_name: parsed.data.contractorName ?? null,
        payer_name: parsed.data.payerName ?? null,
        adr_reference: parsed.data.adrReference ?? null,
        scope: parsed.data.scope,
        received_at: parsed.data.receivedAt ?? null,
        response_due: parsed.data.responseDue ?? null,
        received_via: parsed.data.receivedVia ?? null,
        notes: parsed.data.notes ?? null,
        status: "open",
        sla_status: slaFor({
          response_due: parsed.data.responseDue ?? null,
          status: "open",
        }),
        created_by_email: req.adminEmail ?? null,
      };
    const { data: adr, error } = await supabase
      .from("claim_adr_requests")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) throw error;

    // Seed the response checklist from the default selection for the scope.
    const keys = defaultSelection(parsed.data.scope);
    const docRows: Database["resupply"]["Tables"]["claim_adr_documents"]["Insert"][] =
      keys.map((key) => {
        const item = getAuditPacketItem(key);
        return {
          adr_id: adr.id,
          item_key: key,
          label: item?.label ?? key,
          // Generated items don't need a stored document — mark them satisfied
          // by generation so they don't read as outstanding gaps.
          status: item?.source === "generated" ? "generated" : "outstanding",
        };
      });
    if (docRows.length > 0) {
      await supabase.from("claim_adr_documents").insert(docRows);
    }

    await logAudit({
      action: "adr.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_adr_requests",
      targetId: adr.id,
      metadata: {
        patient_id: parsed.data.patientId,
        claim_id: parsed.data.claimId ?? null,
        source: parsed.data.source,
        scope: parsed.data.scope,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => logger.warn({ err }, "adr.created audit write failed"));

    res.status(201).json({ id: adr.id });
  },
);

// ── GET detail ──────────────────────────────────────────────────────
const idParams = z.object({ id: z.string().uuid() });

router.get(
  "/admin/billing/adr/:id",
  requirePermission("reports.read"),
  async (req, res) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("billing.adr_queue", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: adr } = await supabase
      .from("claim_adr_requests")
      .select("*")
      .eq("id", p.data.id)
      .limit(1)
      .maybeSingle();
    if (!adr) {
      res.status(404).json({ error: "adr_not_found" });
      return;
    }
    const { data: documents } = await supabase
      .from("claim_adr_documents")
      .select("*")
      .eq("adr_id", adr.id)
      .order("created_at", { ascending: true });
    res.json({
      adr: { ...adr, slaStatus: slaFor(adr) },
      documents: documents ?? [],
    });
  },
);

// ── PATCH update ────────────────────────────────────────────────────
const patchBody = z
  .object({
    status: z.enum(["open", "in_progress", "submitted", "closed"]).optional(),
    outcome: z
      .enum(["pending", "favorable", "partial", "unfavorable", "withdrawn"])
      .optional(),
    submittedVia: z.enum(["fax", "mail", "portal"]).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

router.patch(
  "/admin/billing/adr/:id",
  requirePermission("patients.update"),
  adminRateLimit({ name: "adr.update", preset: "mutation" }),
  async (req, res) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("billing.adr_queue", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: existing } = await supabase
      .from("claim_adr_requests")
      .select("id, response_due, status")
      .eq("id", p.data.id)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "adr_not_found" });
      return;
    }

    const nextStatus = parsed.data.status ?? existing.status;
    const update: Database["resupply"]["Tables"]["claim_adr_requests"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (parsed.data.status) update.status = parsed.data.status;
    if (parsed.data.outcome) update.outcome = parsed.data.outcome;
    if (parsed.data.notes !== undefined) update.notes = parsed.data.notes;
    // Stamp submission when moving to submitted.
    if (parsed.data.status === "submitted") {
      update.submitted_at = new Date().toISOString();
      if (parsed.data.submittedVia !== undefined) {
        update.submitted_via = parsed.data.submittedVia;
      }
    }
    update.sla_status = slaFor({
      response_due: existing.response_due,
      status: nextStatus,
    });

    const { error } = await supabase
      .from("claim_adr_requests")
      .update(update)
      .eq("id", existing.id);
    if (error) throw error;

    await logAudit({
      action: "adr.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_adr_requests",
      targetId: existing.id,
      metadata: {
        status: parsed.data.status ?? null,
        outcome: parsed.data.outcome ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => logger.warn({ err }, "adr.updated audit write failed"));

    res.json({ ok: true });
  },
);

export default router;
