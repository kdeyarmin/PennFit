// Fetch wrappers for the manual-documents feature (staff-authored,
// manually-typed PDF documents). Reads need patients.read; mutations
// need patients.update (all enforced server-side). Hand-rolled fetch
// + csrfHeader, same pattern as cmn-documents-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type ManualDocumentType =
  | "cmn"
  | "prescription"
  | "agreement"
  | "delivery_ticket"
  | "cover_letter"
  | "other";

export type ManualDocumentStatus = "draft" | "sent" | "attached";

export type ManualDocumentFieldKind = "text" | "textarea" | "date";

export interface ManualDocumentField {
  key: string;
  label: string;
  kind: ManualDocumentFieldKind;
  placeholder?: string;
}

export interface ManualDocumentTypeDef {
  type: ManualDocumentType;
  label: string;
  description: string;
  phi: boolean;
  requiresSignature: boolean;
  fields: ManualDocumentField[];
}

export interface ManualDocumentSummary {
  id: string;
  document_type: ManualDocumentType;
  title: string;
  status: ManualDocumentStatus;
  patient_id: string | null;
  chart_document_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_fax_e164: string | null;
  last_emailed_at: string | null;
  last_faxed_at: string | null;
  attached_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManualDocumentDetail extends ManualDocumentSummary {
  recipient_address: string | null;
  fields: Record<string, string> | null;
  body: string | null;
}

export interface ManualDocumentInput {
  documentType?: ManualDocumentType;
  title?: string;
  fields?: Record<string, string>;
  body?: string | null;
  recipientName?: string | null;
  recipientAddress?: string | null;
  recipientEmail?: string | null;
  recipientFaxE164?: string | null;
}

export interface PatientSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  pacwareId: string | null;
}

const BASE = "/resupply-api/admin/manual-documents";

async function err(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return new ApiError(res, data, { method, url });
}

function jsonHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...csrfHeader(),
  };
}

export async function getManualDocumentCatalog(): Promise<{
  types: ManualDocumentTypeDef[];
}> {
  const url = `${BASE}/catalog`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { types: ManualDocumentTypeDef[] };
}

export async function listManualDocuments(params?: {
  patientId?: string;
  status?: ManualDocumentStatus;
}): Promise<{ documents: ManualDocumentSummary[] }> {
  const qs = new URLSearchParams();
  if (params?.patientId) qs.set("patientId", params.patientId);
  if (params?.status) qs.set("status", params.status);
  const url = qs.toString() ? `${BASE}?${qs.toString()}` : BASE;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { documents: ManualDocumentSummary[] };
}

export async function getManualDocument(
  id: string,
): Promise<{ document: ManualDocumentDetail }> {
  const url = `${BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { document: ManualDocumentDetail };
}

export async function createManualDocument(
  body: ManualDocumentInput,
): Promise<{ id: string }> {
  const res = await fetch(BASE, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", BASE);
  return (await res.json()) as { id: string };
}

export async function updateManualDocument(
  id: string,
  body: ManualDocumentInput,
): Promise<{ ok: boolean }> {
  const url = `${BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "PATCH", url);
  return (await res.json()) as { ok: boolean };
}

export async function deleteManualDocument(
  id: string,
): Promise<{ ok: boolean }> {
  const url = `${BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) throw await err(res, "DELETE", url);
  return (await res.json()) as { ok: boolean };
}

export function manualDocumentPdfUrl(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}/pdf`;
}

export async function sendManualDocumentEmail(
  id: string,
  body: { email?: string },
): Promise<{ ok: boolean }> {
  const url = `${BASE}/${encodeURIComponent(id)}/send-email`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { ok: boolean };
}

export async function sendManualDocumentFax(
  id: string,
  body: { fax?: string },
): Promise<{ ok: boolean; vendorRef?: string }> {
  const url = `${BASE}/${encodeURIComponent(id)}/send-fax`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { ok: boolean; vendorRef?: string };
}

export async function attachManualDocument(
  id: string,
  body: { patientId?: string },
): Promise<{
  ok: boolean;
  patientId: string;
  patientDocumentId: string | null;
}> {
  const url = `${BASE}/${encodeURIComponent(id)}/attach`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as {
    ok: boolean;
    patientId: string;
    patientDocumentId: string | null;
  };
}

// ── Packets ─────────────────────────────────────────────────────────
// A packet is an ordered bundle of manual documents rendered as ONE
// combined PDF (optional generated cover sheet + each document on a
// fresh page) and sent as a single email attachment or fax.

export type ManualDocumentPacketStatus = "draft" | "sent";

export interface ManualDocumentPacketSummary {
  id: string;
  title: string;
  recipient_name: string | null;
  recipient_address: string | null;
  recipient_email: string | null;
  recipient_fax_e164: string | null;
  document_ids: string[];
  include_cover_sheet: boolean;
  status: ManualDocumentPacketStatus;
  last_emailed_at: string | null;
  last_faxed_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManualDocumentPacketMember {
  id: string;
  document_type: ManualDocumentType;
  title: string;
  status: ManualDocumentStatus;
}

export interface ManualDocumentPacketDetail {
  packet: ManualDocumentPacketSummary;
  documents: ManualDocumentPacketMember[];
  missingDocumentIds: string[];
}

export interface ManualDocumentPacketInput {
  title?: string;
  documentIds?: string[];
  includeCoverSheet?: boolean;
  recipientName?: string | null;
  recipientAddress?: string | null;
  recipientEmail?: string | null;
  recipientFaxE164?: string | null;
}

const PACKETS_BASE = "/resupply-api/admin/manual-document-packets";

export async function listManualDocumentPackets(params?: {
  status?: ManualDocumentPacketStatus;
}): Promise<{ packets: ManualDocumentPacketSummary[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  const url = qs.toString() ? `${PACKETS_BASE}?${qs.toString()}` : PACKETS_BASE;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { packets: ManualDocumentPacketSummary[] };
}

export async function getManualDocumentPacket(
  id: string,
): Promise<ManualDocumentPacketDetail> {
  const url = `${PACKETS_BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as ManualDocumentPacketDetail;
}

export async function createManualDocumentPacket(
  body: ManualDocumentPacketInput,
): Promise<{ id: string }> {
  const res = await fetch(PACKETS_BASE, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", PACKETS_BASE);
  return (await res.json()) as { id: string };
}

export async function updateManualDocumentPacket(
  id: string,
  body: ManualDocumentPacketInput,
): Promise<{ ok: boolean }> {
  const url = `${PACKETS_BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "PATCH", url);
  return (await res.json()) as { ok: boolean };
}

export async function deleteManualDocumentPacket(
  id: string,
): Promise<{ ok: boolean }> {
  const url = `${PACKETS_BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) throw await err(res, "DELETE", url);
  return (await res.json()) as { ok: boolean };
}

export function manualDocumentPacketPdfUrl(id: string): string {
  return `${PACKETS_BASE}/${encodeURIComponent(id)}/pdf`;
}

export async function sendManualDocumentPacketEmail(
  id: string,
  body: { email?: string },
): Promise<{ ok: boolean }> {
  const url = `${PACKETS_BASE}/${encodeURIComponent(id)}/send-email`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { ok: boolean };
}

export async function sendManualDocumentPacketFax(
  id: string,
  body: { fax?: string },
): Promise<{ ok: boolean; vendorRef?: string }> {
  const url = `${PACKETS_BASE}/${encodeURIComponent(id)}/send-fax`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { ok: boolean; vendorRef?: string };
}

// Patient typeahead for the "attach to chart" picker. Hits the shared
// GET /resupply-api/patients list endpoint (search param).
export async function searchPatientsForAttach(
  search: string,
): Promise<PatientSearchResult[]> {
  const qs = new URLSearchParams({ search, limit: "8" });
  const url = `/resupply-api/patients?${qs.toString()}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      pacwareId?: string | null;
    }>;
  };
  return (data.items ?? []).map((p) => ({
    id: p.id,
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
    pacwareId: p.pacwareId ?? null,
  }));
}
