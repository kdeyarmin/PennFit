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
  assessAuditReadiness,
  defaultSelection,
  getAuditPacketItem,
} from "@workspace/resupply-domain";

import {
  buildAuditPacket,
  type FetchedDocument,
} from "../../lib/audit-packet/build-audit-packet";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

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
    const docTypes = new Set(
      ((docRowsRaw ?? []) as Array<{ document_type: string }>).map(
        (d) => d.document_type,
      ),
    );

    // An item is "covered" when the system can produce it (generated) or a
    // matching chart document is on file.
    const coveredKeys: string[] = [];
    for (const item of AUDIT_PACKET_CATALOG) {
      if (item.source === "generated") {
        coveredKeys.push(item.key);
        continue;
      }
      if (item.documentTypes.some((t) => docTypes.has(t))) {
        coveredKeys.push(item.key);
      }
    }

    const readiness = assessAuditReadiness(scope, coveredKeys);
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

    // Optional claim + ADR context (validated to belong to this patient).
    const [claimRes, adrRes] = await Promise.all([
      parsed.data.claimId
        ? supabase
            .from("insurance_claims")
            .select("id, patient_id, claim_number, payer_name, date_of_service")
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
    ]);
    const claim = claimRes.data;
    const adr = adrRes.data;

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
        memberId: null,
      },
      claim: claim
        ? {
            claimNumber: claim.claim_number,
            payerName: claim.payer_name,
            datesOfService: claim.date_of_service,
          }
        : null,
      generatedOn: new Date(),
    });

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
