// Manual-document packet shared service helpers.
//
// Centralises what the admin packet routes AND the fax media route both
// need: loading a packet row, resolving its member documents (in packet
// order, surfacing any that have since been deleted), and rendering the
// packet to a single combined PDF Buffer. Keeping this in one place
// means the downloaded PDF, the emailed attachment, and the faxed media
// are byte-identical.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isManualDocumentType } from "./catalog";
import { renderManualDocumentPacketPdf } from "./packet-pdf";
import {
  manualDocumentSupplierContact,
  buildManualDocumentPdfInput,
  manualDocumentSupplierName,
  MANUAL_DOCUMENT_ROW_COLUMNS,
  type ManualDocumentRow,
} from "./service";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface ManualDocumentPacketRow {
  id: string;
  title: string;
  recipient_name: string | null;
  recipient_address: string | null;
  recipient_email: string | null;
  recipient_fax_e164: string | null;
  document_ids: unknown;
  include_cover_sheet: boolean;
  status: "draft" | "sent";
  last_emailed_at: string | null;
  last_faxed_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

const PACKET_ROW_COLUMNS =
  "id, title, recipient_name, recipient_address, recipient_email, " +
  "recipient_fax_e164, document_ids, include_cover_sheet, status, " +
  "last_emailed_at, last_faxed_at, created_by_email, created_at, updated_at";

export const MANUAL_DOCUMENT_PACKET_ROW_COLUMNS = PACKET_ROW_COLUMNS;

/** The packet's ordered member-document ids, defensively parsed. */
export function packetDocumentIds(row: ManualDocumentPacketRow): string[] {
  if (!Array.isArray(row.document_ids)) return [];
  return row.document_ids.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/** Load one packet row by id. Returns null when not found. */
export async function loadManualDocumentPacketRow(
  supabase: SupabaseClient,
  id: string,
): Promise<ManualDocumentPacketRow | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("manual_document_packets")
    .select(PACKET_ROW_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data as unknown as ManualDocumentPacketRow;
}

export interface PacketDocumentsResult {
  /** Member rows, in packet order (missing ids skipped here). */
  documents: ManualDocumentRow[];
  /** Ids in the packet whose manual_documents row no longer exists. */
  missingIds: string[];
}

/**
 * Resolve a packet's member documents, preserving packet order and
 * reporting any ids whose rows have since been deleted. Callers decide
 * whether missing members are fatal (sending) or informational (detail).
 */
export async function loadPacketDocuments(
  supabase: SupabaseClient,
  packet: ManualDocumentPacketRow,
): Promise<PacketDocumentsResult> {
  const ids = packetDocumentIds(packet);
  if (ids.length === 0) return { documents: [], missingIds: [] };
  const { data, error } = await supabase
    .schema("resupply")
    .from("manual_documents")
    .select(MANUAL_DOCUMENT_ROW_COLUMNS)
    .in("id", ids);
  if (error) throw error;
  const byId = new Map<string, ManualDocumentRow>();
  for (const raw of data ?? []) {
    const row = raw as unknown as ManualDocumentRow;
    if (isManualDocumentType(row.document_type)) byId.set(row.id, row);
  }
  const documents: ManualDocumentRow[] = [];
  const missingIds: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) documents.push(row);
    else missingIds.push(id);
  }
  return { documents, missingIds };
}

/**
 * Render a packet (already-resolved member rows) to a single combined
 * PDF Buffer: optional cover sheet, then each document on a fresh page.
 */
export async function renderManualDocumentPacketToPdf(
  supabase: SupabaseClient,
  packet: ManualDocumentPacketRow,
  documents: ManualDocumentRow[],
  generatedOn: Date = new Date(),
): Promise<Buffer> {
  const inputs = [];
  for (const row of documents) {
    inputs.push(await buildManualDocumentPdfInput(supabase, row, generatedOn));
  }
  const supplierContact = await manualDocumentSupplierContact();
  return renderManualDocumentPacketPdf({
    title: packet.title,
    recipient: {
      name: packet.recipient_name,
      address: packet.recipient_address,
      email: packet.recipient_email,
      fax: packet.recipient_fax_e164,
    },
    documents: inputs,
    includeCoverSheet: packet.include_cover_sheet,
    supplierContact,
    supplierName: manualDocumentSupplierName(),
    generatedOn,
  });
}

/**
 * Render a packet to PDF bytes for the Telnyx fax media URL. Returns
 * null when the packet is gone or has no surviving member documents, so
 * the fax route can 404 (the fax then fails loudly instead of
 * transmitting a silently incomplete packet — the send route validates
 * members exist before dispatch, so this only races a concurrent delete).
 */
export async function renderManualDocumentPacketForFax(
  supabase: SupabaseClient,
  packetId: string,
): Promise<Buffer | null> {
  const packet = await loadManualDocumentPacketRow(supabase, packetId);
  if (!packet) return null;
  const { documents, missingIds } = await loadPacketDocuments(supabase, packet);
  if (documents.length === 0 || missingIds.length > 0) return null;
  return renderManualDocumentPacketToPdf(supabase, packet, documents);
}
