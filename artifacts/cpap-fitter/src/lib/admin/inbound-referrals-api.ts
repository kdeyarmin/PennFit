// Hand-rolled fetch wrapper for /admin/inbound-referrals — the CSR
// triage surface for inbound electronic DME orders (Parachute Health
// today, EHR FHIR partners after Phase 4).
//
// Mirrors the shape of inbound-faxes-api.ts so the page can borrow
// the same patterns (React Query, toast errors, optimistic invalidate).

export type ReferralTriageStatus =
  | "new"
  | "triaged"
  | "accepted"
  | "rejected"
  | "duplicate"
  | "archived";

export type ReferralListFilter = "open" | ReferralTriageStatus;

export type ReferralLifecycleEvent =
  | "order.accepted"
  | "order.rejected"
  | "prior_auth.decision"
  | "shop_order.shipped"
  | "shop_order.delivered";

export type PreflightOutcomeStatus =
  | "info"
  | "ok"
  | "warn"
  | "error"
  | "skipped";

export interface ReferralListItem {
  id: string;
  source: string;
  sourceOrderId: string;
  triageStatus: ReferralTriageStatus;
  patientMatchId: string | null;
  patientMatchKind: string | null;
  providerMatchId: string | null;
  providerMatchKind: string | null;
  aiConfidence: number | null;
  payerName: string | null;
  orderingNpi: string | null;
  receivedAt: string;
  triagedAt: string | null;
  acceptedAt: string | null;
  acceptedOrderId: string | null;
  acceptedOrderKind: string | null;
  notes: string | null;
}

export interface ReferralDocument {
  id: string;
  kind: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  sourceDocumentId: string | null;
  objectKey: string | null;
  createdAt: string;
}

export interface ReferralPreflightCheck {
  id: string;
  checkKind: string;
  outcomeStatus: PreflightOutcomeStatus;
  outcomeJson: Record<string, unknown> | null;
  producedRowTable: string | null;
  producedRowId: string | null;
  ranBy: string;
  createdAt: string;
}

export interface ReferralStatusCallback {
  id: string;
  targetKind: "parachute" | "ehr_fhir";
  eventType: string;
  status: "queued" | "delivered" | "failed" | "exhausted";
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string;
  createdAt: string;
}

export interface ReferralShareToken {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  createdByEmail: string;
  createdAt: string;
}

export interface ReferralAiClassification {
  intent: "new_patient" | "refill" | "replacement" | "resupply" | "unknown";
  confidence: number;
  summary: string;
  flags: string[];
}

export interface ReferralDetail extends ReferralListItem {
  inboundWebhookId: string | null;
  aiClassification: ReferralAiClassification | null;
  hcpcsItems: unknown;
  icd10Codes: unknown;
  parsed: Record<string, unknown> | null;
  assignedAdminUserId: string | null;
  triagedByUserId: string | null;
  acceptedByUserId: string | null;
  preflightCompletedAt: string | null;
  createdAt: string;
  documents: ReferralDocument[];
  preflightChecks: ReferralPreflightCheck[];
  statusCallbacks: ReferralStatusCallback[];
  shareTokens: ReferralShareToken[];
}

export interface SuggestedPatient {
  id: string;
  legalFirstName: string | null;
  legalLastName: string | null;
  email: string | null;
  phoneE164: string | null;
  dateOfBirth: string | null;
  kind: "exact_phone" | "exact_dob_last_name" | "fuzzy_phone_tail";
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function listInboundReferrals(
  status: ReferralListFilter = "open",
): Promise<{ referrals: ReferralListItem[] }> {
  return jsonFetch(
    `/admin/inbound-referrals?status=${encodeURIComponent(status)}`,
  );
}

export async function getInboundReferral(id: string): Promise<ReferralDetail> {
  return jsonFetch(`/admin/inbound-referrals/${encodeURIComponent(id)}`);
}

export async function getSuggestedPatients(
  id: string,
): Promise<{ candidates: SuggestedPatient[] }> {
  return jsonFetch(
    `/admin/inbound-referrals/${encodeURIComponent(id)}/suggested-patients`,
  );
}

export interface PatchReferralRequest {
  status?: "new" | "triaged" | "rejected" | "duplicate" | "archived";
  patientMatchId?: string | null;
  providerMatchId?: string | null;
  assignedAdminUserId?: string | null;
  notes?: string | null;
}

export async function patchInboundReferral(
  id: string,
  body: PatchReferralRequest,
): Promise<{ id: string; changed: boolean }> {
  return jsonFetch(`/admin/inbound-referrals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface AcceptReferralRequest {
  patientId: string;
  providerId?: string | null;
  acceptedOrderKind: string;
  acceptedOrderId: string;
  notes?: string | null;
}

export async function acceptInboundReferral(
  id: string,
  body: AcceptReferralRequest,
): Promise<{ id: string; accepted: true }> {
  return jsonFetch(
    `/admin/inbound-referrals/${encodeURIComponent(id)}/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function runPreflight(
  id: string,
): Promise<{ id: string; checks: Array<{ kind: string; status: string }> }> {
  return jsonFetch(
    `/admin/inbound-referrals/${encodeURIComponent(id)}/run-preflight`,
    { method: "POST" },
  );
}

export async function resendStatus(
  id: string,
  eventType: ReferralLifecycleEvent,
): Promise<{ outboxId: string; queued: true }> {
  return jsonFetch(
    `/admin/inbound-referrals/${encodeURIComponent(id)}/resend-status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType }),
    },
  );
}

export async function mintShareToken(
  id: string,
  ttlSeconds?: number,
): Promise<{ shareTokenId: string; token: string; expiresAt: string }> {
  return jsonFetch(
    `/admin/inbound-referrals/${encodeURIComponent(id)}/share-tokens`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    },
  );
}

export async function revokeShareToken(
  referralId: string,
  shareTokenId: string,
): Promise<{ revoked: true; alreadyRevoked?: boolean }> {
  return jsonFetch(
    `/admin/inbound-referrals/${encodeURIComponent(referralId)}/share-tokens/${encodeURIComponent(shareTokenId)}`,
    { method: "DELETE" },
  );
}
