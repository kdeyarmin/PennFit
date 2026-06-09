// Manual-document shared service helpers.
//
// Centralises the bits the admin routes AND the fax media route both
// need: loading a row, resolving the supplier/practice name, and
// rendering a row to a PDF Buffer. Keeping this in one place means the
// downloaded PDF, the emailed attachment, the faxed media, and the
// chart-filed copy are byte-identical.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isManualDocumentType, type ManualDocumentType } from "./catalog";
import { renderManualDocumentPdf, type ManualDocumentPdfInput } from "./pdf";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface ManualDocumentRow {
  id: string;
  document_type: ManualDocumentType;
  title: string;
  recipient_name: string | null;
  recipient_address: string | null;
  recipient_email: string | null;
  recipient_fax_e164: string | null;
  fields: Record<string, unknown> | null;
  body: string | null;
  patient_id: string | null;
  chart_document_id: string | null;
  status: "draft" | "sent" | "attached";
  last_emailed_at: string | null;
  last_faxed_at: string | null;
  attached_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

const ROW_COLUMNS =
  "id, document_type, title, recipient_name, recipient_address, " +
  "recipient_email, recipient_fax_e164, fields, body, patient_id, " +
  "chart_document_id, status, last_emailed_at, last_faxed_at, " +
  "attached_at, created_by_email, created_at, updated_at";

export const MANUAL_DOCUMENT_ROW_COLUMNS = ROW_COLUMNS;

/** Practice / supplier name for the PDF letterhead. */
export function manualDocumentSupplierName(): string {
  return process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";
}

/** Load one row by id. Returns null when not found or the type is bad. */
export async function loadManualDocumentRow(
  supabase: SupabaseClient,
  id: string,
): Promise<ManualDocumentRow | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("manual_documents")
    .select(ROW_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // ROW_COLUMNS is a runtime-concatenated select string, so PostgREST
  // can't infer the row shape — cast to the known shape, then validate
  // the discriminant.
  const row = data as unknown as ManualDocumentRow;
  if (!isManualDocumentType(row.document_type)) return null;
  return row;
}

/** Render a loaded row to a PDF Buffer. */
export function renderManualDocumentRowToPdf(
  row: ManualDocumentRow,
  generatedOn: Date = new Date(),
): Promise<Buffer> {
  const input: ManualDocumentPdfInput = {
    documentType: row.document_type,
    title: row.title,
    recipient: {
      name: row.recipient_name,
      address: row.recipient_address,
      email: row.recipient_email,
      fax: row.recipient_fax_e164,
    },
    fields: (row.fields ?? null) as Record<string, unknown> | null,
    body: row.body,
    supplierName: manualDocumentSupplierName(),
    generatedOn,
  };
  return renderManualDocumentPdf(input);
}
