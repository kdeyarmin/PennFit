// Audit-packet creator.
//
//   GET  /admin/audit-packet/catalog
//        — the selectable CPAP/PAP audit-document catalog + default
//          selections by scope, so the UI can render the checklist.
//
//   POST /admin/patients/:id/audit-packet
//        — assemble the selected documents (stored chart docs + generated
//          summaries) into ONE audit-response PDF and stream it back. Records
//          an audit_packets row for traceability. "Like running a report":
//          choose what to print, get the packet.
//
// Gated behind the billing.adr_queue feature flag. PHI: the generated PDF is
// patient chart content — streamed/attached, never logged; only counts go to
// the audit row + logger.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";
import {
  AUDIT_PACKET_CATALOG,
  type AuditScope,
  WINDOW_DAYS,
  assessAuditReadiness,
  coveredKeysFromDocumentTypes,
  defaultSelection,
  findBestAdherenceWindow,
  getAuditPacketItem,
} from "@workspace/resupply-domain";

import {
  type AuditAdherence,
  buildAuditPacket,
  type FetchedDocument,
} from "../../lib/audit-packet/build-audit-packet";
import {
  createTelnyxFaxClient,
  TelnyxApiError,
} from "@workspace/resupply-telecom";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { signAuditPacketFaxToken } from "../../lib/fax-document-token";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { resolveTenantFaxFrom } from "../../lib/messaging/tenant-telecom";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { getFaxPublicBaseUrl, isFaxConfigured } from "./physician-fax-outreach";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const SCOPES = ["device", "supplies", "both"] as const;

// GET catalog — static metadata + defaults. Cheap; reports.read.
router.get(
  "/admin/audit-packet/catalog",
  requirePermission("reports.read"),
  async (req, res) => {
    if (!(await isFeatureEnabled("billing.adr_queue", req.orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    res.json({
      items: AUDIT_PACKET_CATALOG,
      defaults: {
        device: defaultSelection("device"),
        supplies: defaultSelection("supplies"),
        both: defaultSelection("both"),
      },
    });
  },
);

// GET audit-readiness — proactive gap check: which audit-critical chart
// documents the patient is missing, before an ADR ever arrives.
const readinessParams = z.object({ id: z.string().uuid() });
const readinessQuery = z.object({ scope: z.enum(SCOPES).default("device") });

router.get(
  "/admin/patients/:id/audit-readiness",
  requirePermission("patients.read"),
  async (req, res) => {
    const idParsed = readinessParams.safeParse(req.params);
    const qParsed = readinessQuery.safeParse(req.query);
    if (!idParsed.success || !qParsed.success) {
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
    const scope = qParsed.data.scope as AuditScope;
    const supabase = getOrgScopedClient(orgId);
    const { data: docRowsRaw } = await supabase
      .from("patient_documents")
      .select("document_type")
      .eq("patient_id", idParsed.data.id);
    const docTypes = (
      (docRowsRaw ?? []) as Array<{ document_type: string }>
    ).map((d) => d.document_type);
    const readiness = assessAuditReadiness(
      scope,
      coveredKeysFromDocumentTypes(docTypes),
    );
    res.json({
      readiness,
      items: readiness.required.map((key) => ({
        key,
        label: getAuditPacketItem(key)?.label ?? key,
        present: readiness.present.includes(key),
      })),
    });
  },
);

const buildParams = z.object({ id: z.string().uuid() });
const buildBody = z
  .object({
    scope: z.enum(SCOPES).default("device"),
    selectedKeys: z.array(z.string()).max(50).optional(),
    claimId: z.string().uuid().nullable().optional(),
    adrId: z.string().uuid().nullable().optional(),
  })
  .strict();

/** Fetch a stored object's bytes + content type, or null if unavailable. */
async function fetchObjectBytes(
  objectKey: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const file = await objectStorage.getObjectEntityFile(objectKey);
    const response = await objectStorage.downloadObject(file, 0);
    if (!response.ok || !response.body) return null;
    const arrayBuf = await response.arrayBuffer();
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    return { bytes: Buffer.from(arrayBuf), contentType };
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return null;
    logger.warn({ err }, "audit_packet.object_fetch_failed");
    return null;
  }
}

/** Upload a generated packet PDF to the private bucket; returns the stored
 *  object key, or null on any failure (best-effort persistence). */
async function persistPacketPdf(
  patientId: string,
  pdf: Buffer,
): Promise<string | null> {
  try {
    const uploadUrl = await objectStorage.getObjectEntityUploadURL();
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdf,
    });
    if (!put.ok) return null;
    return await objectStorage.trySetObjectEntityAclPolicy(uploadUrl, {
      owner: patientId,
      visibility: "private",
    });
  } catch (err) {
    logger.warn({ err }, "audit_packet.persist_failed");
    return null;
  }
}

// GET history — past audit packets for a patient (newest first).
router.get(
  "/admin/patients/:id/audit-packets",
  requirePermission("patients.read"),
  async (req, res) => {
    const idParsed = buildParams.safeParse(req.params);
    if (!idParsed.success) {
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
    const { data } = await supabase
      .from("audit_packets")
      .select(
        "id, scope, item_count, page_count, size_bytes, object_key, adr_id, claim_id, generated_by_email, generated_at",
      )
      .eq("patient_id", idParsed.data.id)
      .order("generated_at", { ascending: false })
      .limit(50);
    res.json({ packets: data ?? [] });
  },
);

// GET download — stream a persisted packet PDF from history.
router.get(
  "/admin/audit-packets/:id/pdf",
  requirePermission("patients.read"),
  async (req, res) => {
    const idParsed = buildParams.safeParse(req.params);
    if (!idParsed.success) {
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
    const { data: row } = await supabase
      .from("audit_packets")
      .select("id, object_key")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!row || !row.object_key) {
      res.status(404).json({ error: "packet_not_found" });
      return;
    }
    const bytes = await fetchObjectBytes(row.object_key);
    if (!bytes) {
      res.status(404).json({ error: "packet_unavailable" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-packet-${row.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).end(bytes.bytes);
  },
);

// POST fax — fax a persisted packet to a contractor's fax number, and stamp
// the linked ADR submitted. Reuses the appeal-fax pipeline (signed mediaUrl +
// Telnyx). Fail-soft on missing fax config (503, not 500).
const faxBody = z
  .object({
    faxNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/),
  })
  .strict();

router.post(
  "/admin/audit-packets/:id/fax",
  requirePermission("patients.update"),
  adminRateLimit({ name: "audit_packet.fax", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = buildParams.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = faxBody.safeParse(req.body);
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
    const { data: row } = await supabase
      .from("audit_packets")
      .select("id, object_key, adr_id")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!row || !row.object_key) {
      res.status(404).json({ error: "packet_not_persisted" });
      return;
    }
    if (!isFaxConfigured()) {
      res.status(503).json({ error: "fax_not_configured" });
      return;
    }
    const baseUrl = getFaxPublicBaseUrl()!;
    const token = signAuditPacketFaxToken(row.id);
    const mediaUrl = `${baseUrl}/resupply-api/fax/document/${token}`;
    const statusCallbackUrl = `${baseUrl}/resupply-api/fax/webhook`;
    const tenantFrom = await resolveTenantFaxFrom(orgId);
    const fromNumber = tenantFrom ?? process.env.TELNYX_FAX_FROM_NUMBER!.trim();

    let vendorRef: string;
    try {
      const result = await createTelnyxFaxClient().sendFax({
        to: parsed.data.faxNumber,
        from: fromNumber,
        mediaUrl,
        statusCallbackUrl,
      });
      vendorRef = result.id;
    } catch (err) {
      const msg =
        err instanceof TelnyxApiError
          ? `Telnyx fax error: ${err.message}`
          : `Fax dispatch error: ${String(err)}`;
      logger.warn(
        { event: "audit_packet_fax_failed", packetId: row.id },
        "audit_packet.fax: Telnyx dispatch failed",
      );
      res.status(502).json({ error: "fax_dispatch_failed", message: msg });
      return;
    }

    // Telnyx accepted — stamp the linked ADR as submitted by fax.
    if (row.adr_id) {
      const nowIso = new Date().toISOString();
      await supabase
        .from("claim_adr_requests")
        .update({
          status: "submitted",
          submitted_at: nowIso,
          submitted_via: "fax",
          submitted_packet_id: row.id,
          sla_status: "decided",
          updated_at: nowIso,
        })
        .eq("id", row.adr_id);
    }

    await logAudit({
      action: "audit_packet.faxed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "audit_packets",
      targetId: row.id,
      metadata: {
        adr_id: row.adr_id,
        vendor_ref: vendorRef,
        vendor_name: "telnyx",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "audit_packet.faxed audit write failed");
    });

    res.json({ ok: true, vendorRef });
  },
);

router.post(
  "/admin/patients/:id/audit-packet",
  requirePermission("patients.read"),
  adminRateLimit({ name: "audit_packet.build", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = buildParams.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = buildBody.safeParse(req.body);
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
    const patientId = idParsed.data.id;
    const scope = parsed.data.scope as AuditScope;
    const selectedKeys = parsed.data.selectedKeys ?? defaultSelection(scope);

    const supabase = getOrgScopedClient(orgId);
    const { data: patient } = await supabase
      .from("patients")
      .select("id, legal_first_name, legal_last_name, date_of_birth")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    // Optional claim + ADR context (validated to belong to this patient), plus
    // the structured data the generated summaries render from.
    const [claimRes, adrRes, nightsRes, equipRes, coverageRes] =
      await Promise.all([
        parsed.data.claimId
          ? supabase
              .from("insurance_claims")
              .select(
                "id, patient_id, claim_number, payer_name, date_of_service, total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents",
              )
              .eq("id", parsed.data.claimId)
              .eq("patient_id", patientId)
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        parsed.data.adrId
          ? supabase
              .from("claim_adr_requests")
              .select(
                "id, patient_id, source, contractor_name, payer_name, adr_reference, received_at, response_due",
              )
              .eq("id", parsed.data.adrId)
              .eq("patient_id", patientId)
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        supabase
          .from("patient_therapy_nights")
          .select("night_date, usage_minutes")
          .eq("patient_id", patientId)
          .order("night_date", { ascending: true })
          .limit(400),
        supabase
          .from("equipment_assets")
          .select(
            "device_class, manufacturer, model, serial_number, dispensed_at",
          )
          .eq("patient_id", patientId)
          .eq("status", "active")
          .limit(50),
        supabase
          .from("insurance_coverages")
          .select("member_id, payer_name")
          .eq("patient_id", patientId)
          .eq("rank", "primary")
          .limit(1)
          .maybeSingle(),
      ]);
    const claim = claimRes.data;
    const adr = adrRes.data;
    const coverage = coverageRes.data;

    // Claim line items (HCPCS / modifiers) when a claim is in context.
    let lineItems: Array<{ hcpcs_code: string; modifier: string | null }> = [];
    if (claim) {
      const { data: liRaw } = await supabase
        .from("insurance_claim_line_items")
        .select("hcpcs_code, modifier")
        .eq("claim_id", claim.id);
      lineItems = (liRaw ?? []) as Array<{
        hcpcs_code: string;
        modifier: string | null;
      }>;
    }

    // Adherence window from device nights (Medicare 4h/70%/30-day rule).
    const nights = (
      (nightsRes.data ?? []) as Array<{
        night_date: string;
        usage_minutes: number | null;
      }>
    ).map((n) => ({ date: n.night_date, usageMinutes: n.usage_minutes }));
    let adherence: AuditAdherence | null = null;
    let lastUsageDate: string | null = null;
    if (nights.length > 0) {
      const anchor = nights[0]!.date;
      const today = new Date().toISOString().slice(0, 10);
      const result = findBestAdherenceWindow(nights, anchor, today);
      const w = result.window;
      if (w) {
        adherence = {
          windowStart: w.startDate,
          windowEnd: w.endDate,
          nightsUsed: w.compliantNights,
          nightsTotal: WINDOW_DAYS,
          avgHoursPerNight: w.averageUsageHoursOnUsedNights,
          meetsCms: result.qualifies,
        };
      }
      const used = nights.filter((n) => (n.usageMinutes ?? 0) > 0);
      lastUsageDate = used.length > 0 ? used[used.length - 1]!.date : null;
    }

    const equipment = (
      (equipRes.data ?? []) as Array<{
        device_class: string;
        manufacturer: string | null;
        model: string | null;
        serial_number: string | null;
        dispensed_at: string | null;
      }>
    ).map((e) => ({
      hcpcs: "",
      description: [e.device_class, e.model].filter(Boolean).join(" "),
      serialNumber: e.serial_number,
      manufacturer: e.manufacturer,
      dispensedOn: e.dispensed_at,
    }));

    // Resolve company identity for the cover-sheet letterhead.
    const identity = await resolveBillingIdentity({ orgId });
    const bp = identity.billingProvider;

    // Pull the patient's stored documents and bucket them by catalog item.
    const { data: docRowsRaw } = await supabase
      .from("patient_documents")
      .select("id, object_key, document_type, content_type, filename")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false });
    const docRows = (docRowsRaw ?? []) as Array<{
      id: string;
      object_key: string;
      document_type: string;
      content_type: string;
      filename: string | null;
    }>;

    const documentsByItem: Record<string, FetchedDocument[]> = {};
    for (const key of selectedKeys) {
      const item = getAuditPacketItem(key);
      if (!item || item.documentTypes.length === 0) continue;
      const matches = docRows.filter((d) =>
        item.documentTypes.includes(d.document_type),
      );
      const fetched: FetchedDocument[] = [];
      for (const d of matches) {
        const bytes = await fetchObjectBytes(d.object_key);
        if (bytes) {
          fetched.push({
            label: d.filename ?? item.label,
            bytes: bytes.bytes,
            contentType: bytes.contentType || d.content_type,
            filename: d.filename,
          });
        }
      }
      if (fetched.length > 0) documentsByItem[key] = fetched;
    }

    const result = await buildAuditPacket({
      scope,
      selectedKeys,
      adr: adr
        ? {
            source: adr.source,
            contractorName: adr.contractor_name,
            payerName: adr.payer_name,
            adrReference: adr.adr_reference,
            receivedAt: adr.received_at,
            responseDue: adr.response_due,
          }
        : null,
      company: {
        legalName: identity.organization?.legal_name ?? bp.organizationName,
        npi: bp.npi ?? null,
        addressLines: [
          bp.address.line1,
          `${bp.address.city}, ${bp.address.state} ${bp.address.zip}`,
        ].filter(Boolean),
        phone: identity.organization?.phone_e164 ?? null,
      },
      patient: {
        name: `${patient.legal_first_name} ${patient.legal_last_name}`,
        dateOfBirth: patient.date_of_birth,
        memberId: coverage?.member_id ?? null,
      },
      claim: claim
        ? {
            claimNumber: claim.claim_number,
            payerName: claim.payer_name,
            datesOfService: claim.date_of_service,
            hcpcs: Array.from(
              new Set(lineItems.map((l) => l.hcpcs_code).filter(Boolean)),
            ),
            modifiers: Array.from(
              new Set(
                lineItems
                  .flatMap((l) => (l.modifier ?? "").split(/[,\s]+/))
                  .filter(Boolean),
              ),
            ),
            billedCents: claim.total_billed_cents,
            allowedCents: claim.total_allowed_cents,
            paidCents: claim.total_paid_cents,
          }
        : null,
      adherence,
      equipment,
      continuedUse:
        lastUsageDate || adherence
          ? {
              lastUsageDate,
              method: "device data",
              note: "Continued use established from connected device therapy data.",
            }
          : null,
      generatedOn: new Date(),
    });

    // Persist the packet PDF to private object storage so it can be
    // re-downloaded from history. Best-effort — a storage hiccup must not fail
    // the build (the operator still gets the streamed PDF).
    const objectKey = await persistPacketPdf(patientId, result.pdf);

    // Record the build for traceability (counts only — no PHI).
    const missing = result.items
      .filter((i) => i.status === "missing")
      .map((i) => i.key);
    const insertRow: Database["resupply"]["Tables"]["audit_packets"]["Insert"] =
      {
        patient_id: patientId,
        claim_id: claim?.id ?? null,
        adr_id: adr?.id ?? null,
        scope,
        selected_items: selectedKeys,
        item_count: result.items.filter((i) => i.status !== "missing").length,
        page_count: result.pageCount,
        size_bytes: result.pdf.length,
        object_key: objectKey,
        generated_by_email: req.adminEmail ?? null,
      };
    const { data: packetRow } = await supabase
      .from("audit_packets")
      .insert(insertRow)
      .select("id")
      .single();

    await logAudit({
      action: "audit_packet.generated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "audit_packets",
      targetId: packetRow?.id ?? null,
      metadata: {
        patient_id: patientId,
        claim_id: claim?.id ?? null,
        adr_id: adr?.id ?? null,
        item_count: insertRow.item_count,
        page_count: result.pageCount,
        missing_count: missing.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "audit_packet.generated audit write failed");
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-packet-${patientId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Audit-Packet-Pages", String(result.pageCount));
    res.setHeader("X-Audit-Packet-Missing", missing.join(","));
    if (packetRow?.id) res.setHeader("X-Audit-Packet-Id", packetRow.id);
    res.status(201).end(result.pdf);
  },
);

export default router;
