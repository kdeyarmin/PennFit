// Manual-document shared service helpers.
//
// Centralises the bits the admin routes AND the fax media route both
// need: loading a row, resolving the supplier/practice name, and
// rendering a row to a PDF Buffer. Keeping this in one place means the
// downloaded PDF, the emailed attachment, the faxed media, and the
// chart-filed copy are byte-identical.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  getCompanyInfoSync,
  getDocumentSupplierNameSync,
} from "../company-info";
import { getTrackingCodeForDocument } from "../signature-tracking/service";
import { isManualDocumentType, type ManualDocumentType } from "./catalog";
import {
  renderManualDocumentPdf,
  type ManualDocumentPdfInput,
  type ManualDocumentSupplierContact,
} from "./pdf";

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

/** Supplier name for the PDF letterhead — the registered DME legal name. */
export function manualDocumentSupplierName(): string {
  return getDocumentSupplierNameSync();
}

function formatCompanyAddress(
  address: ReturnType<typeof getCompanyInfoSync>["address"],
): string | null {
  if (!address) return null;
  const parts: string[] = [];
  if (address.line1) parts.push(address.line1);
  if (address.line2) parts.push(address.line2);
  const cityLine = [
    address.city,
    [address.state, address.zip].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  if (cityLine) parts.push(cityLine);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Supplier contact/identifier block for official payer PDFs. */
export function manualDocumentSupplierContact(): ManualDocumentSupplierContact {
  const info = getCompanyInfoSync();
  return {
    address: formatCompanyAddress(info.address),
    phone: info.phoneDisplay,
    fax: info.faxE164,
    email: info.generalEmail,
    npi: info.organizationalNpi,
    website: info.websiteUrl,
  };
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

/**
 * Build the renderer input for a loaded row. Fetches the document's
 * signature-tracking code (if any) so the rendered PDF carries the
 * top-right tracking barcode. Shared by the individual render below and
 * the packet renderer (packet-service.ts) so a document's pages look the
 * same whether sent alone or inside a packet.
 */
export async function buildManualDocumentPdfInput(
  supabase: SupabaseClient,
  row: ManualDocumentRow,
  generatedOn: Date,
): Promise<ManualDocumentPdfInput> {
  // Best-effort: if the signature_tracking query fails (e.g. during a
  // migration window or a transient DB hiccup), render the PDF without
  // a barcode rather than failing the whole download.
  const trackingCode = await getTrackingCodeForDocument(
    supabase,
    "manual_document",
    row.id,
  ).catch(() => null);
  return {
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
    supplierContact: manualDocumentSupplierContact(),
    generatedOn,
    trackingCode,
  };
}

/**
 * Render a loaded row to a PDF Buffer — keeping every channel (download,
 * email, fax, chart copy) byte-identical.
 */
export async function renderManualDocumentRowToPdf(
  supabase: SupabaseClient,
  row: ManualDocumentRow,
  generatedOn: Date = new Date(),
): Promise<Buffer> {
  const input = await buildManualDocumentPdfInput(supabase, row, generatedOn);
  return renderManualDocumentPdf(input);
}
