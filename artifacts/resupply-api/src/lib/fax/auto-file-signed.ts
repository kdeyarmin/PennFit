// Auto-file a returned signed fax from its barcode.
//
// Called best-effort from the inbound-fax ingest (lib/fax/ingest-inbound)
// AFTER the fax bytes are mirrored to object storage, and ONLY when the
// `fax.auto_file_signed` feature flag is on (the ingest checks the flag;
// this module assumes it's enabled). It:
//
//   1. Scans the fax for the PennFit signature-tracking code (PFS-XXXXXXXX)
//      via the BAA-covered Claude vision path (lib/inbound-fax/tracking-scan).
//   2. Looks the code up in signature_tracking. On an exact match to an
//      OUTSTANDING (awaiting_signature) row that carries a patient, it:
//        a. copies the fax bytes into a NEW object and files them into the
//           patient's chart (a patient_documents row, retention-stamped,
//           marked reviewed — a verified barcode match needs no human ack);
//        b. marks the signature returned & signed, cascading to the source
//           prescription packet (markReturnedAndCascade);
//        c. satisfies any outstanding claim paperwork requirement the
//           tracked document was sent to clear (releasing the bill hold);
//        d. attaches the inbound_faxes row to the patient and records the
//           match outcome.
//
// Never throws — a failure leaves the fax in the triage queue for a manual
// link exactly as before, with auto_file_status recording why. PHI: the
// chart document + fax bytes live under their own object-storage ACL; this
// module logs only the opaque tracking code + ids, never patient text.

import type { Logger } from "pino";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { satisfyRequirement } from "../billing/bill-hold";
import { scanFaxForTrackingCode } from "../inbound-fax/tracking-scan";
import { logger as defaultLogger } from "../logger";
import { ObjectStorageService } from "../object-storage/objectStorage";
import { computeRetentionUntilAt } from "../patient-documents/retention";
import {
  lookupTrackingByCode,
  markReturnedAndCascade,
  type SignatureDocumentKind,
} from "../signature-tracking/service";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/** Outcome enum — mirrors the inbound_faxes.auto_file_status CHECK
 *  constraint (migration 0258). */
export type AutoFileStatus =
  | "filed"
  | "no_code"
  | "no_match"
  | "already_returned"
  | "no_patient"
  | "failed"
  | "unsupported"
  | "offline";

export interface AutoFileSignedFaxInput {
  /** The inbound_faxes row id. */
  faxId: string;
  /** The fax media bytes (already in memory from the ingest download). */
  bytes: Buffer;
  /** Resolved content type of the media (application/pdf for most faxes). */
  contentType: string;
}

export interface AutoFileSignedFaxDeps {
  supabase?: SupabaseClient;
  logger?: Logger;
  /** Injectable for tests; defaults to the real vision scan. */
  scan?: typeof scanFaxForTrackingCode;
  /** Injectable for tests; defaults to a fresh ObjectStorageService. */
  storage?: ObjectStorageService;
}

export interface AutoFileOutcome {
  status: AutoFileStatus;
  trackingCode: string | null;
  signatureTrackingId: string | null;
  chartDocumentId: string | null;
}

/** Chart document_type to file under, keyed by the tracked document kind.
 *  Both values are valid chart-document types (chart-document-types.ts). */
const CHART_DOC_TYPE_BY_KIND: Record<SignatureDocumentKind, string> = {
  prescription_request: "prescription",
  manual_document: "agreement",
};

function extensionFor(contentType: string): string {
  if (contentType.includes("pdf")) return "pdf";
  if (contentType.includes("tiff") || contentType.includes("tif"))
    return "tiff";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  return "bin";
}

/** Persist the auto-file outcome columns on the inbound_faxes row.
 *  Best-effort: a patch failure is logged but never thrown. */
async function recordOutcome(
  supabase: SupabaseClient,
  log: Logger,
  faxId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_faxes")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", faxId);
  if (error) {
    log.warn(
      { err: error.message, fax_id_first8: faxId.slice(0, 8) },
      "fax_auto_file_outcome_patch_failed",
    );
  }
}

/**
 * Attempt to auto-file a returned signed fax from its barcode. Assumes the
 * `fax.auto_file_signed` flag has already been checked by the caller.
 * Never throws.
 */
export async function autoFileSignedFax(
  input: AutoFileSignedFaxInput,
  deps: AutoFileSignedFaxDeps = {},
): Promise<AutoFileOutcome> {
  const supabase = deps.supabase ?? getSupabaseServiceRoleClient();
  const log = deps.logger ?? defaultLogger;
  const scan = deps.scan ?? scanFaxForTrackingCode;

  const fail = async (
    status: AutoFileStatus,
    trackingCode: string | null,
    signatureTrackingId: string | null,
  ): Promise<AutoFileOutcome> => {
    await recordOutcome(supabase, log, input.faxId, {
      auto_file_status: status,
      tracking_code_detected: trackingCode,
      signature_tracking_id: signatureTrackingId,
    });
    return { status, trackingCode, signatureTrackingId, chartDocumentId: null };
  };

  try {
    // 1. Read the tracking code off the page.
    const scanResult = await scan({
      bytes: input.bytes,
      contentType: input.contentType,
    });
    if (scanResult.status === "offline") return fail("offline", null, null);
    if (scanResult.status === "unsupported")
      return fail("unsupported", null, null);
    if (scanResult.status === "failed") return fail("failed", null, null);
    if (scanResult.status === "not_found") return fail("no_code", null, null);

    const code = scanResult.code;

    // 2. Resolve the code to a tracked document.
    const tracking = await lookupTrackingByCode(supabase, code).catch(
      () => null,
    );
    if (!tracking) return fail("no_match", code, null);
    if (tracking.status !== "awaiting_signature") {
      // The signed copy is back, but the row was already cleared (a CSR
      // filed it, or a duplicate fax). No-op beyond recording the match.
      return fail("already_returned", code, tracking.id);
    }
    if (!tracking.patientId) {
      // We can mark the signature returned (it genuinely came back) but
      // there's no patient to file it under — leave it for manual triage.
      await markReturnedAndCascade(supabase, tracking).catch((err) => {
        log.warn({ err }, "fax_auto_file_mark_returned_failed");
      });
      return fail("no_patient", code, tracking.id);
    }

    // 3. Copy the fax bytes into a NEW object and file them into the chart.
    //    A separate object keeps the chart document independent of the
    //    fax-inbox media (own ACL owner + own retention horizon), exactly
    //    like a manual chart upload.
    const storage = deps.storage ?? new ObjectStorageService();
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": input.contentType },
      body: input.bytes,
    });
    if (!putResp.ok) {
      log.warn(
        { status: putResp.status, fax_id_first8: input.faxId.slice(0, 8) },
        "fax_auto_file_chart_put_failed",
      );
      return fail("failed", code, tracking.id);
    }
    const chartObjectKey = await storage.trySetObjectEntityAclPolicy(
      uploadUrl,
      { owner: tracking.patientId, visibility: "private" },
    );
    if (!chartObjectKey) return fail("failed", code, tracking.id);

    const documentType =
      CHART_DOC_TYPE_BY_KIND[tracking.documentKind] ?? "other";
    const nowIso = new Date().toISOString();
    const retentionUntilAt = computeRetentionUntilAt({
      createdAt: new Date(nowIso),
      documentType,
    }).toISOString();
    const { data: insertedDoc, error: docErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .insert({
        patient_id: tracking.patientId,
        object_key: chartObjectKey,
        document_type: documentType,
        filename: `signed-${code}.${extensionFor(input.contentType)}`,
        content_type: input.contentType,
        size_bytes: input.bytes.length,
        // A verified barcode match is reviewed by definition — keep it out
        // of the unreviewed queue. No admin id: the system filed it.
        reviewed_at: nowIso,
        reviewed_by_admin_id: null,
        retention_until_at: retentionUntilAt,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (docErr || !insertedDoc) {
      log.warn(
        { err: docErr?.message, fax_id_first8: input.faxId.slice(0, 8) },
        "fax_auto_file_chart_insert_failed",
      );
      return fail("failed", code, tracking.id);
    }
    const chartDocumentId = insertedDoc.id as string;

    // 4. Mark the signature returned & signed (cascades to the source
    //    prescription packet).
    await markReturnedAndCascade(supabase, tracking).catch((err) => {
      log.warn({ err }, "fax_auto_file_mark_returned_failed");
    });

    // 5. Satisfy any outstanding claim paperwork requirement this exact
    //    document was sent to clear — releasing the bill hold. The source
    //    soft pointer matches the tracked document kind.
    const requirementsSatisfied = await satisfyMatchingRequirements(
      supabase,
      log,
      tracking.documentKind,
      tracking.documentId,
      input.faxId,
      chartDocumentId,
    );

    // 6. Attach the fax to the patient + record the match.
    await recordOutcome(supabase, log, input.faxId, {
      status: "attached",
      attached_patient_id: tracking.patientId,
      attached_provider_id: tracking.providerId,
      attached_document_type: documentType,
      tracking_code_detected: code,
      signature_tracking_id: tracking.id,
      chart_document_id: chartDocumentId,
      auto_file_status: "filed",
      auto_filed_at: nowIso,
      triaged_at: nowIso,
    });

    await logAudit({
      action: "fax.auto_filed_signed",
      targetTable: "inbound_faxes",
      targetId: input.faxId,
      metadata: {
        // tracking_code is an opaque handle (not PHI) — the
        // signature-tracking route logs it too.
        tracking_code: code,
        signature_tracking_id: tracking.id,
        document_kind: tracking.documentKind,
        chart_document_filed: true,
        requirements_satisfied: requirementsSatisfied,
      },
    }).catch((err: unknown) => {
      log.warn({ err }, "fax.auto_filed_signed audit write failed");
    });

    return {
      status: "filed",
      trackingCode: code,
      signatureTrackingId: tracking.id,
      chartDocumentId,
    };
  } catch (err) {
    log.warn(
      {
        event: "fax_auto_file_unexpected_error",
        err: err instanceof Error ? err.message : String(err),
        fax_id_first8: input.faxId.slice(0, 8),
      },
      "fax auto-file: unexpected error (non-fatal)",
    );
    await recordOutcome(supabase, log, input.faxId, {
      auto_file_status: "failed",
    }).catch(() => undefined);
    return {
      status: "failed",
      trackingCode: null,
      signatureTrackingId: null,
      chartDocumentId: null,
    };
  }
}

/**
 * Satisfy every outstanding claim paperwork requirement whose source
 * soft-pointer is this tracked document. Best-effort; returns the count
 * satisfied. A requirement is matched on source_packet_id (for a
 * prescription request) or source_manual_document_id (for a manual
 * document) — the same id signature_tracking carries as documentId.
 */
async function satisfyMatchingRequirements(
  supabase: SupabaseClient,
  log: Logger,
  documentKind: SignatureDocumentKind,
  documentId: string,
  faxId: string,
  chartDocumentId: string,
): Promise<number> {
  try {
    const sourceCol =
      documentKind === "prescription_request"
        ? "source_packet_id"
        : "source_manual_document_id";
    const { data, error } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .select("id")
      .eq(sourceCol, documentId)
      .eq("status", "outstanding");
    if (error) throw error;
    const reqs = (data ?? []) as { id: string }[];
    let satisfied = 0;
    for (const r of reqs) {
      await satisfyRequirement(r.id, {
        supabase,
        via: "inbound_fax",
        actorEmail: "system:fax-barcode",
        inboundFaxId: faxId,
        documentId: chartDocumentId,
      });
      satisfied += 1;
    }
    return satisfied;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "fax_auto_file_satisfy_requirements_failed",
    );
    return 0;
  }
}
