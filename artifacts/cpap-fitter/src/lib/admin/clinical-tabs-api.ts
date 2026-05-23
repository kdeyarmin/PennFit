// Hand-rolled fetch wrappers for the three Tier-2a clinical tabs on
// patient-detail: sleep studies, insurance coverages, prior auths.
// Bundled in one file because they share the same patient-scoped URL
// shape and the same project-as-camelCase pattern.

import { csrfHeader } from "../csrf";

export type SleepStudyType = "psg" | "hsat" | "split_night" | "re_titration";
export type SleepStudySource =
  | "external_lab"
  | "home_test_vendor"
  | "csr_entry";

export interface SleepStudy {
  id: string;
  studyDate: string;
  studyType: SleepStudyType;
  ahi: number;
  rdi: number | null;
  lowestSpo2Pct: number | null;
  sleepEfficiencyPct: number | null;
  diagnosisIcd10: string | null;
  interpretingProviderId: string | null;
  facilityName: string | null;
  source: SleepStudySource;
  documentId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CreateSleepStudyRequest {
  studyDate: string;
  studyType: SleepStudyType;
  ahi: number;
  rdi?: number | null;
  lowestSpo2Pct?: number | null;
  sleepEfficiencyPct?: number | null;
  diagnosisIcd10?: string | null;
  interpretingProviderId?: string | null;
  facilityName?: string | null;
  source?: SleepStudySource;
  notes?: string | null;
}

export type CoverageRank = "primary" | "secondary" | "tertiary";
export type Relationship = "self" | "spouse" | "child" | "other";
export type CappedRentalStatus =
  | "rental_month_1_to_3"
  | "rental_month_4_to_13"
  | "purchased"
  | "not_applicable";

export interface InsuranceCoverage {
  id: string;
  rank: CoverageRank;
  payerName: string;
  planName: string | null;
  memberId: string;
  groupNumber: string | null;
  policyholderName: string | null;
  policyholderRelationship: Relationship | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  inNetwork: boolean | null;
  deductibleCents: number | null;
  deductibleMetCents: number | null;
  oopMaxCents: number | null;
  copayCents: number | null;
  cappedRentalStatus: CappedRentalStatus | null;
  verifiedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInsuranceCoverageRequest {
  rank: CoverageRank;
  payerName: string;
  planName?: string | null;
  memberId: string;
  groupNumber?: string | null;
  policyholderName?: string | null;
  policyholderRelationship?: Relationship | null;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  inNetwork?: boolean | null;
  deductibleCents?: number | null;
  deductibleMetCents?: number | null;
  oopMaxCents?: number | null;
  copayCents?: number | null;
  cappedRentalStatus?: CappedRentalStatus | null;
  notes?: string | null;
}

export type PriorAuthStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "denied"
  | "appealed"
  | "expired";

export interface PriorAuthorization {
  id: string;
  insuranceCoverageId: string | null;
  hcpcsCode: string;
  payerName: string;
  authNumber: string | null;
  status: PriorAuthStatus;
  requestedAt: string | null;
  submittedAt: string | null;
  decisionAt: string | null;
  approvedThrough: string | null;
  denialReason: string | null;
  documentId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePriorAuthorizationRequest {
  insuranceCoverageId?: string | null;
  hcpcsCode: string;
  payerName: string;
  authNumber?: string | null;
  status?: PriorAuthStatus;
  approvedThrough?: string | null;
  denialReason?: string | null;
  notes?: string | null;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    headers: { Accept: "application/json", ...csrfHeader(), ...(init.headers ?? {}) },
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

// ── Sleep studies ──────────────────────────────────────────────────

export const listSleepStudies = (patientId: string) =>
  jsonFetch<{ studies: SleepStudy[] }>(
    `/patients/${encodeURIComponent(patientId)}/sleep-studies`,
  );

export const createSleepStudy = (
  patientId: string,
  body: CreateSleepStudyRequest,
) =>
  jsonFetch<{ id: string }>(
    `/patients/${encodeURIComponent(patientId)}/sleep-studies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

// ── Insurance coverages ────────────────────────────────────────────

export const listInsuranceCoverages = (patientId: string) =>
  jsonFetch<{ coverages: InsuranceCoverage[] }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-coverages`,
  );

export const createInsuranceCoverage = (
  patientId: string,
  body: CreateInsuranceCoverageRequest,
) =>
  jsonFetch<{ id: string }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-coverages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

// ── Eligibility checks (per-patient) ───────────────────────────────

export type EligibilityCheckStatus =
  | "queued"
  | "submitted"
  | "parsed"
  | "rejected"
  | "transport_failed";

/** Per-patient eligibility-check row. Mirrors the `*` projection
 *  returned by GET /admin/patients/:id/eligibility-checks — the
 *  backend hands back snake_case columns straight from Supabase. */
export interface EligibilityCheck {
  id: string;
  patient_id: string;
  insurance_coverage_id: string;
  payer_profile_id: string | null;
  service_hcpcs: string | null;
  status: EligibilityCheckStatus;
  is_active: boolean | null;
  in_network: boolean | null;
  deductible_cents: number | null;
  deductible_met_cents: number | null;
  oop_max_cents: number | null;
  oop_met_cents: number | null;
  copay_cents: number | null;
  coinsurance_pct: number | null;
  requires_prior_auth: boolean | null;
  error_message: string | null;
  requested_at: string;
  responded_at: string | null;
  requested_by_email: string;
}

export const listEligibilityChecks = (patientId: string) =>
  jsonFetch<{ checks: EligibilityCheck[] }>(
    `/admin/patients/${encodeURIComponent(patientId)}/eligibility-checks`,
  );

export interface VerifyEligibilityResponse {
  eligibilityCheckId: string;
  isaControlNumber: string;
  traceReference: string;
  uploadOk: boolean;
  errorMessage: string | null;
}

export const verifyEligibility = (
  patientId: string,
  coverageId: string,
  body?: { hcpcsCode?: string },
) =>
  jsonFetch<VerifyEligibilityResponse>(
    `/admin/patients/${encodeURIComponent(patientId)}/insurance-coverages/${encodeURIComponent(coverageId)}/verify-eligibility`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  );

// ── Prior authorizations ───────────────────────────────────────────

export const listPriorAuthorizations = (patientId: string) =>
  jsonFetch<{ priorAuthorizations: PriorAuthorization[] }>(
    `/patients/${encodeURIComponent(patientId)}/prior-authorizations`,
  );

export const createPriorAuthorization = (
  patientId: string,
  body: CreatePriorAuthorizationRequest,
) =>
  jsonFetch<{ id: string }>(
    `/patients/${encodeURIComponent(patientId)}/prior-authorizations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

// ── Insurance claims ───────────────────────────────────────────────

export type InsuranceClaimStatus =
  | "draft"
  | "submitted"
  | "accepted"
  | "denied"
  | "paid"
  | "appealed"
  | "closed";

export type InsuranceClaimLineStatus =
  | "pending"
  | "accepted"
  | "denied"
  | "paid";

export type InsuranceClaimEventType =
  | "submitted"
  | "accepted"
  | "denied"
  | "partial_pay"
  | "paid"
  | "appealed"
  | "closed"
  | "note";

export interface InsuranceClaim {
  id: string;
  insuranceCoverageId: string | null;
  payerName: string;
  claimNumber: string | null;
  dateOfService: string;
  fulfillmentId: string | null;
  status: InsuranceClaimStatus;
  totalBilledCents: number;
  totalAllowedCents: number;
  totalPaidCents: number;
  patientResponsibilityCents: number;
  submittedAt: string | null;
  decisionAt: string | null;
  paidAt: string | null;
  denialReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsuranceClaimLineItem {
  id: string;
  hcpcsCode: string;
  modifier: string | null;
  description: string | null;
  quantity: number;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  status: InsuranceClaimLineStatus;
  denialReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsuranceClaimEvent {
  id: string;
  eventType: InsuranceClaimEventType;
  amountCents: number | null;
  payerRef: string | null;
  documentId: string | null;
  note: string | null;
  actorEmail: string;
  occurredAt: string;
}

export interface CreateInsuranceClaimRequest {
  insuranceCoverageId?: string | null;
  payerName: string;
  dateOfService: string;
  fulfillmentId?: string | null;
  claimNumber?: string | null;
  notes?: string | null;
}

export interface PatchInsuranceClaimRequest {
  status?: InsuranceClaimStatus;
  claimNumber?: string | null;
  denialReason?: string | null;
  notes?: string | null;
  submittedAt?: string | null;
  decisionAt?: string | null;
  paidAt?: string | null;
  patientResponsibilityCents?: number;
}

export interface CreateInsuranceClaimLineRequest {
  hcpcsCode: string;
  modifier?: string | null;
  description?: string | null;
  quantity?: number;
  billedCents: number;
}

export interface CreateInsuranceClaimEventRequest {
  eventType: InsuranceClaimEventType;
  amountCents?: number | null;
  payerRef?: string | null;
  documentId?: string | null;
  note?: string | null;
}

export const listInsuranceClaims = (patientId: string) =>
  jsonFetch<{ insuranceClaims: InsuranceClaim[] }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims`,
  );

export const getInsuranceClaim = (patientId: string, claimId: string) =>
  jsonFetch<{
    claim: InsuranceClaim;
    lineItems: InsuranceClaimLineItem[];
    events: InsuranceClaimEvent[];
  }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims/${encodeURIComponent(claimId)}`,
  );

export const createInsuranceClaim = (
  patientId: string,
  body: CreateInsuranceClaimRequest,
) =>
  jsonFetch<{ id: string }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const patchInsuranceClaim = (
  patientId: string,
  claimId: string,
  body: PatchInsuranceClaimRequest,
) =>
  jsonFetch<{ ok: true }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims/${encodeURIComponent(claimId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const createInsuranceClaimLine = (
  patientId: string,
  claimId: string,
  body: CreateInsuranceClaimLineRequest,
) =>
  jsonFetch<{ id: string }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims/${encodeURIComponent(claimId)}/lines`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const createInsuranceClaimEvent = (
  patientId: string,
  claimId: string,
  body: CreateInsuranceClaimEventRequest,
) =>
  jsonFetch<{ id: string }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims/${encodeURIComponent(claimId)}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

// ─── Preflight + Submit-to-Office-Ally (per-claim) ────────────────

export type PreflightSeverity = "ok" | "warning" | "error";

export interface PreflightItem {
  key: string;
  severity: PreflightSeverity;
  label: string;
  detail: string;
}

export interface PreflightSummary {
  readyToSubmit: boolean;
  errorCount: number;
  warningCount: number;
  items: PreflightItem[];
}

export const fetchInsuranceClaimPreflight = (
  patientId: string,
  claimId: string,
) =>
  jsonFetch<{ preflight: PreflightSummary }>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims/${encodeURIComponent(claimId)}/preflight`,
  );

export interface SubmitClaimToOfficeAllyResponse {
  ok: true;
  submissionId: string;
  isaControlNumber: string;
  gsControlNumber: string;
  claimCount: number;
  fileSizeBytes: number;
  transport: string;
}

export const submitInsuranceClaimToOfficeAlly = (
  patientId: string,
  claimId: string,
  body?: { usageIndicator?: "P" | "T"; note?: string },
) =>
  jsonFetch<SubmitClaimToOfficeAllyResponse>(
    `/patients/${encodeURIComponent(patientId)}/insurance-claims/${encodeURIComponent(claimId)}/submit-office-ally`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  );
