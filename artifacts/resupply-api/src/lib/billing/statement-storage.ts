// Persist a generated patient billing statement PDF.
//
// When a statement is generated we (a) upload the rendered PDF to the
// private object bucket, (b) stamp `statement_pdf_object_key` on the
// statement row so the email send can sign a real download link, and
// (c) file a copy in the patient's CHART (`patient_documents`,
// document_type `billing_statement`) so staff see the bill on the
// record and the patient sees it in their portal documents.
//
// Fail-soft by contract: statement generation must NOT fail because
// object storage hiccupped. Every step is best-effort — on failure we
// log a warning and return what succeeded. The statement row already
// exists (snapshot in `line_items_json`) and the patient portal
// re-renders the PDF on demand, so a missed copy degrades gracefully
// rather than breaking the generate action.
//
// PHI posture: the statement is patient PHI. We upload the bytes and
// record counts / object keys only — never the amount, the patient
// name, or the rendered text in a log line.

import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import { logger } from "../logger";
import { computeRetentionUntilAt } from "../patient-documents/retention";
import { ObjectStorageService } from "../object-storage/objectStorage";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

const STATEMENT_DOCUMENT_TYPE = "billing_statement";

export interface PersistStatementInput {
  patientId: string;
  statementId: string;
  pdf: Buffer;
  /** Admin who generated the statement (stamped as the chart reviewer). */
  adminUserId?: string | null;
  supabase?: SupabaseClient;
  storage?: ObjectStorageService;
}

export interface PersistStatementResult {
  /** The `/objects/...` key the PDF was stored under, or null on failure. */
  objectKey: string | null;
  /** The patient_documents chart row id, or null when no copy was filed. */
  chartDocumentId: string | null;
}

/**
 * Upload the statement PDF to object storage, link it on the statement
 * row, and file a chart copy. Never throws — returns partial results on
 * failure so the caller (the generate route) can stream the PDF back to
 * the admin regardless.
 */
export async function persistStatementPdfCopy(
  input: PersistStatementInput,
): Promise<PersistStatementResult> {
  const supabase = input.supabase ?? getSupabaseServiceRoleClient();
  const storage = input.storage ?? new ObjectStorageService();
  const result: PersistStatementResult = {
    objectKey: null,
    chartDocumentId: null,
  };

  // 1. Upload the bytes to the private bucket and claim them for the
  //    patient (mirrors the inbound-MMS server-side upload pattern).
  let objectKey: string;
  try {
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array(input.pdf),
    });
    if (!putResp.ok) {
      logger.warn(
        { event: "billing.statement.persist", status: putResp.status },
        "statement PDF upload non-2xx",
      );
      return result;
    }
    objectKey = await storage.trySetObjectEntityAclPolicy(uploadUrl, {
      owner: input.patientId,
      visibility: "private",
    });
  } catch (err) {
    logger.warn(
      { event: "billing.statement.persist", err },
      "statement PDF upload failed",
    );
    return result;
  }
  result.objectKey = objectKey;

  // 2. Link the stored PDF on the statement row (so the email send can
  //    sign a real download link instead of a bare balance notice).
  try {
    await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .update({ statement_pdf_object_key: objectKey })
      .eq("id", input.statementId);
  } catch (err) {
    logger.warn(
      { event: "billing.statement.persist", err },
      "statement pdf object-key link failed",
    );
    // Non-fatal — keep going to file the chart copy.
  }

  // 3. File a copy in the patient chart. Staff-generated → reviewed by
  //    definition, so it stays out of the unreviewed queue.
  try {
    const nowIso = new Date().toISOString();
    const retentionUntilAt = computeRetentionUntilAt({
      createdAt: new Date(nowIso),
      documentType: STATEMENT_DOCUMENT_TYPE,
    }).toISOString();
    const insertRow: Database["resupply"]["Tables"]["patient_documents"]["Insert"] =
      {
        patient_id: input.patientId,
        object_key: objectKey,
        document_type: STATEMENT_DOCUMENT_TYPE,
        filename: `statement-${input.statementId.slice(0, 8)}.pdf`,
        content_type: "application/pdf",
        size_bytes: input.pdf.length,
        reviewed_at: nowIso,
        reviewed_by_admin_id: input.adminUserId ?? null,
        retention_until_at: retentionUntilAt,
        created_at: nowIso,
        updated_at: nowIso,
      };
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .insert(insertRow)
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    result.chartDocumentId = row?.id ?? null;
  } catch (err) {
    logger.warn(
      { event: "billing.statement.persist", err },
      "statement chart-copy insert failed",
    );
  }

  logger.info(
    {
      event: "billing.statement.persist",
      statement_id: input.statementId,
      filed_to_chart: result.chartDocumentId !== null,
    },
    "billing.statement.persist",
  );
  return result;
}
