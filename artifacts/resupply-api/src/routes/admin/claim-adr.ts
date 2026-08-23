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
  type AuditScope,
  aggregateAdrOutcomes,
  assessAuditReadiness,
  classifyAdrSla,
  coveredKeysFromDocumentTypes,
  defaultSelection,
  getAuditPacketItem,
} from "@workspace/resupply-domain";

import { extractAdrFromFax } from "../../lib/adr/extract-from-fax";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { ObjectStorageService } from "../../lib/object-storage/objectStorage";
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
    const coveredFor = (patientId: string): string[] =>
      coveredKeysFromDocumentTypes([
        ...(docTypesByPatient.get(patientId) ?? new Set<string>()),
      ]);

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
    }).catch((err) =>
      logger.warn({ err: redactDbErr(err) }, "adr.created audit write failed"),
    );

    res.status(201).json({ id: adr.id });
  },
);

// ── POST suggest-from-fax (AI intake) ───────────────────────────────
// Read an inbound ADR fax and extract the fields that pre-fill the create
// form. Fail-soft: returns {status:'offline'|'failed'|...} rather than erroring.
const suggestBody = z.object({ inboundFaxId: z.string().uuid() }).strict();

router.post(
  "/admin/billing/adr/suggest-from-fax",
  requirePermission("patients.update"),
  adminRateLimit({ name: "adr.suggest", preset: "sensitive" }),
  async (req, res) => {
    const parsed = suggestBody.safeParse(req.body);
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
    const { data: fax } = await supabase
      .from("inbound_faxes")
      .select("media_object_key, media_content_type")
      .eq("id", parsed.data.inboundFaxId)
      .limit(1)
      .maybeSingle();
    if (!fax || !fax.media_object_key) {
      res.status(404).json({ error: "fax_not_found" });
      return;
    }
    try {
      const storage = new ObjectStorageService();
      const file = await storage.getObjectEntityFile(fax.media_object_key);
      const resp = await storage.downloadObject(file, 0);
      if (!resp.ok || !resp.body) {
        res.json({ status: "unsupported", reason: "unavailable" });
        return;
      }
      const bytes = Buffer.from(await resp.arrayBuffer());
      const extraction = await extractAdrFromFax({
        bytes,
        contentType: fax.media_content_type,
      });
      res.json(extraction);
    } catch (err) {
      logger.warn({ err: redactDbErr(err) }, "adr.suggest_from_fax failed");
      res.json({ status: "failed", reason: "fetch_error" });
    }
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
    // The patient's stored chart documents, so the detail UI can offer them
    // when attaching a checklist item.
    const { data: patientDocs } = await supabase
      .from("patient_documents")
      .select("id, document_type, filename, created_at")
      .eq("patient_id", adr.patient_id)
      .order("created_at", { ascending: false })
      .limit(200);
    res.json({
      adr: { ...adr, slaStatus: slaFor(adr) },
      documents: documents ?? [],
      patientDocuments: patientDocs ?? [],
    });
  },
);

// ── PATCH a checklist document (attach / waive / mark generated) ─────
const docPatchParams = z.object({
  id: z.string().uuid(),
  docId: z.string().uuid(),
});
const docPatchBody = z
  .object({
    status: z.enum(["outstanding", "attached", "generated", "waived", "na"]),
    documentId: z.string().uuid().nullable().optional(),
    waivedReason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

router.patch(
  "/admin/billing/adr/:id/documents/:docId",
  requirePermission("patients.update"),
  adminRateLimit({ name: "adr.doc_update", preset: "mutation" }),
  async (req, res) => {
    const p = docPatchParams.safeParse(req.params);
    const b = docPatchBody.safeParse(req.body);
    if (!p.success || !b.success) {
      res.status(400).json({ error: "invalid_request" });
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
    // The checklist row must belong to the ADR in the path.
    const { data: row } = await supabase
      .from("claim_adr_documents")
      .select("id, adr_id")
      .eq("id", p.data.docId)
      .limit(1)
      .maybeSingle();
    if (!row || row.adr_id !== p.data.id) {
      res.status(404).json({ error: "document_not_found" });
      return;
    }
    const update: Database["resupply"]["Tables"]["claim_adr_documents"]["Update"] =
      {
        status: b.data.status,
        updated_at: new Date().toISOString(),
      };
    if (b.data.status === "attached") {
      update.document_id = b.data.documentId ?? null;
      update.attached_at = new Date().toISOString();
      update.attached_via = "upload";
      update.attached_by_email = req.adminEmail ?? null;
    } else if (b.data.status === "waived") {
      update.waived_reason = b.data.waivedReason ?? null;
    }
    const { error } = await supabase
      .from("claim_adr_documents")
      .update(update)
      .eq("id", p.data.docId);
    if (error) throw error;
    res.json({ ok: true });
  },
);

// ── GET outcome analytics ───────────────────────────────────────────
// Overturn/win rate + counts by contractor source over a window, from closed
// ADRs. A feedback loop on which audits are worth fighting.
router.get(
  "/admin/billing/adr-analytics",
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
    const { data } = await supabase
      .from("claim_adr_requests")
      .select("source, outcome, status")
      .in("status", ["submitted", "closed"])
      .limit(2000);
    const rows = (data ?? []) as Array<{ source: string; outcome: string }>;
    res.json(aggregateAdrOutcomes(rows));
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
    }).catch((err) =>
      logger.warn({ err: redactDbErr(err) }, "adr.updated audit write failed"),
    );

    res.json({ ok: true });
  },
);

export default router;
