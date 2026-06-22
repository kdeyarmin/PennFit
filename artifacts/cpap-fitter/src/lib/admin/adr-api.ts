// Fetch wrappers for the Medicare ADR / audit-response queue and the
// audit-packet builder (migration 0457). reports.read for the worklist +
// catalog + detail; patients.update for create/update; patients.read to
// build a packet. All gated server-side behind the billing.adr_queue flag.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type AdrSource =
  | "rac"
  | "cert"
  | "tpe"
  | "upic"
  | "payer_medical_review"
  | "other";
export type AdrScope = "device" | "supplies" | "both";
export type AdrStatus = "open" | "in_progress" | "submitted" | "closed";
export type AdrOutcome =
  | "pending"
  | "favorable"
  | "partial"
  | "unfavorable"
  | "withdrawn";
export type AdrSlaStatus = "on_track" | "at_risk" | "overdue" | "decided";

export interface AdrWorklistItem {
  id: string;
  patient_id: string;
  claim_id: string | null;
  source: AdrSource;
  contractor_name: string | null;
  payer_name: string | null;
  adr_reference: string | null;
  scope: AdrScope;
  received_at: string | null;
  response_due: string | null;
  status: AdrStatus;
  outcome: AdrOutcome;
  slaStatus: AdrSlaStatus;
  daysOut: number | null;
  outstandingDocs: number;
  auditReady?: boolean;
  missingRequired?: number;
}

export interface AdrWorklist {
  items: AdrWorklistItem[];
  counts: { total: number; atRisk: number; overdue: number };
}

export interface AdrDocument {
  id: string;
  adr_id: string;
  item_key: string;
  label: string;
  status: "outstanding" | "attached" | "generated" | "waived" | "na";
  document_id: string | null;
  created_at: string;
}

export interface AdrDetail {
  adr: AdrWorklistItem & { notes: string | null; submitted_at: string | null };
  documents: AdrDocument[];
}

export interface AuditCatalogItem {
  key: string;
  label: string;
  description: string;
  group: string;
  source: "on_file" | "generated" | "hybrid";
  documentTypes: string[];
  scope: AdrScope;
  defaultForDevice: boolean;
  defaultForSupplies: boolean;
}

export interface AuditCatalog {
  items: AuditCatalogItem[];
  defaults: { device: string[]; supplies: string[]; both: string[] };
}

async function err(
  res: Response,
  method: string,
  url: string,
): Promise<ApiError> {
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
    "Content-Type": "application/json",
    Accept: "application/json",
    ...csrfHeader(),
  };
}

export async function getAdrWorklist(): Promise<AdrWorklist> {
  const url = "/resupply-api/admin/billing/adr-worklist";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as AdrWorklist;
}

export async function getAdr(id: string): Promise<AdrDetail> {
  const url = `/resupply-api/admin/billing/adr/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as AdrDetail;
}

export interface CreateAdrInput {
  patientId: string;
  claimId?: string | null;
  source: AdrSource;
  contractorName?: string | null;
  payerName?: string | null;
  adrReference?: string | null;
  scope: AdrScope;
  receivedAt?: string | null;
  responseDue?: string | null;
  notes?: string | null;
}

export async function createAdr(
  input: CreateAdrInput,
): Promise<{ id: string }> {
  const url = "/resupply-api/admin/billing/adr";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { id: string };
}

export async function updateAdr(
  id: string,
  body: {
    status?: AdrStatus;
    outcome?: AdrOutcome;
    submittedVia?: "fax" | "mail" | "portal" | null;
    notes?: string | null;
  },
): Promise<void> {
  const url = `/resupply-api/admin/billing/adr/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "PATCH", url);
}

export interface AuditReadiness {
  readiness: {
    scope: AdrScope;
    required: string[];
    present: string[];
    missing: string[];
    score: number;
    ready: boolean;
  };
  items: { key: string; label: string; present: boolean }[];
}

export async function getAuditReadiness(
  patientId: string,
  scope: AdrScope,
): Promise<AuditReadiness> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/audit-readiness?scope=${scope}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as AuditReadiness;
}

export async function getAuditPacketCatalog(): Promise<AuditCatalog> {
  const url = "/resupply-api/admin/audit-packet/catalog";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as AuditCatalog;
}

export interface BuildPacketResult {
  blob: Blob;
  filename: string;
  pages: number;
  missing: string[];
}

export interface AuditPacketRecord {
  id: string;
  scope: AdrScope;
  item_count: number;
  page_count: number | null;
  size_bytes: number | null;
  object_key: string | null;
  adr_id: string | null;
  claim_id: string | null;
  generated_by_email: string | null;
  generated_at: string;
}

export async function getAuditPacketHistory(
  patientId: string,
): Promise<{ packets: AuditPacketRecord[] }> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/audit-packets`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { packets: AuditPacketRecord[] };
}

export async function downloadHistoricalPacket(
  packetId: string,
): Promise<Blob> {
  const url = `/resupply-api/admin/audit-packets/${encodeURIComponent(packetId)}/pdf`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/pdf" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return await res.blob();
}

/** Build + download an audit packet PDF for a patient. Returns the blob plus
 *  the per-build summary read from response headers. */
export async function buildAuditPacket(
  patientId: string,
  body: {
    scope: AdrScope;
    selectedKeys?: string[];
    claimId?: string | null;
    adrId?: string | null;
  },
): Promise<BuildPacketResult> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/audit-packet`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { ...jsonHeaders(), Accept: "application/pdf" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  const blob = await res.blob();
  const missingHeader = res.headers.get("X-Audit-Packet-Missing") ?? "";
  return {
    blob,
    filename: `audit-packet-${patientId.slice(0, 8)}.pdf`,
    pages: Number(res.headers.get("X-Audit-Packet-Pages") ?? 0),
    missing: missingHeader ? missingHeader.split(",").filter(Boolean) : [],
  };
}
