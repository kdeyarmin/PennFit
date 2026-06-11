// Auto-file the signed packet PDF onto the patient's chart.
//
// Fired (fire-and-forget) by the public signing route the moment a
// packet completes. Renders the same signed PDF the admin download
// route serves (signed-pdf.ts) and files it as a patient_documents row
// — the digital equivalent of the CSR downloading the PDF and
// uploading it to the chart by hand. Mirrors the manual-documents
// attach flow (routes/admin/manual-documents.ts).
//
// Posture:
//   * BEST-EFFORT — every failure is logged and swallowed. Filing must
//     never break or delay the patient's signing response; the PDF can
//     always be regenerated on demand from the packet.
//   * Skips silently when: the flag is off, the packet is unlinked
//     (no patient chart to file onto), the packet isn't completed,
//     it was already filed (chart_document_id set), or object storage
//     isn't configured (dev/preview).
//   * PHI: PDF bytes are uploaded, never logged. Audit metadata is
//     ids + flags only.

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../object-storage/objectStorage";
import { computeRetentionUntilAt } from "../patient-documents/retention";
import { buildSignedPacketPdf } from "./signed-pdf";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/** The chart tag the filed packet carries (a valid chart-document-types
 *  value; the packet is a bundle of signed consents/agreements). */
const CHART_DOCUMENT_TYPE = "agreement";

export interface AutofileResult {
  filed: boolean;
  reason?:
    | "flag_off"
    | "not_found"
    | "not_completed"
    | "no_patient"
    | "already_filed"
    | "storage_unconfigured"
    | "error";
}

/**
 * File the signed PDF for a just-completed packet. Returns a result
 * for tests; production call sites fire-and-forget.
 */
export async function autofileSignedPacketPdf(
  supabase: SupabaseClient,
  packetId: string,
): Promise<AutofileResult> {
  try {
    if (!(await isFeatureEnabled("patient_packets.autofile_signed_pdf"))) {
      return { filed: false, reason: "flag_off" };
    }
    if (!process.env.SUPABASE_STORAGE_BUCKET_PRIVATE?.trim()) {
      return { filed: false, reason: "storage_unconfigured" };
    }

    // Idempotency + eligibility gate before any rendering work.
    const { data: gate, error: gateErr } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .select("id, patient_id, status, chart_document_id")
      .eq("id", packetId)
      .limit(1)
      .maybeSingle();
    if (gateErr) throw gateErr;
    if (!gate) return { filed: false, reason: "not_found" };
    if (gate.status !== "completed") {
      return { filed: false, reason: "not_completed" };
    }
    if (!gate.patient_id) return { filed: false, reason: "no_patient" };
    if (gate.chart_document_id) {
      return { filed: false, reason: "already_filed" };
    }

    const built = await buildSignedPacketPdf(supabase, packetId);
    if (!built) return { filed: false, reason: "not_found" };

    // Upload to private object storage, owned by the patient — same
    // pattern as the manual-documents attach path.
    const objectStorage = new ObjectStorageService();
    const uploadUrl = await objectStorage.getObjectEntityUploadURL();
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: built.pdf,
    });
    if (!putResp.ok) {
      throw new Error(`signed packet upload failed (HTTP ${putResp.status})`);
    }
    const objectKey = await objectStorage.trySetObjectEntityAclPolicy(
      uploadUrl,
      { owner: gate.patient_id, visibility: "private" },
    );

    const nowIso = new Date().toISOString();
    // The packet's signed POD is a DMEPOS billing-support record with a
    // 7-year CMS horizon; without one the 6-year agreement floor holds.
    const retentionUntilAt = computeRetentionUntilAt({
      createdAt: new Date(nowIso),
      documentType: built.includesProofOfDelivery
        ? "signed_delivery_ticket"
        : CHART_DOCUMENT_TYPE,
    }).toISOString();

    const { data: docRow, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .insert({
        patient_id: gate.patient_id,
        object_key: objectKey,
        document_type: CHART_DOCUMENT_TYPE,
        filename: `signed-packet-${packetId.slice(0, 8)}.pdf`,
        content_type: "application/pdf",
        size_bytes: built.pdf.byteLength,
        retention_until_at: retentionUntilAt,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    // Stamp the packet. The chart_document_id IS NULL guard makes a
    // concurrent double-fire insert at most one stamp; a lost race
    // leaves an extra (harmless, identical) chart copy.
    const { error: stampErr } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .update({
        chart_document_id: docRow.id,
        chart_filed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", packetId)
      .is("chart_document_id", null);
    if (stampErr) throw stampErr;

    await logAudit({
      action: "patient_packet.chart_filed",
      targetTable: "patient_packets",
      targetId: packetId,
      metadata: {
        patient_id: gate.patient_id,
        chart_document_id: docRow.id,
        size_bytes: built.pdf.byteLength,
      },
    }).catch((err) => {
      logger.warn({ err }, "patient_packet.chart_filed audit write failed");
    });

    return { filed: true };
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return { filed: false, reason: "storage_unconfigured" };
    }
    logger.warn(
      {
        err,
        packetId,
      },
      "patient packet auto-file to chart failed (non-fatal; PDF remains downloadable)",
    );
    return { filed: false, reason: "error" };
  }
}
