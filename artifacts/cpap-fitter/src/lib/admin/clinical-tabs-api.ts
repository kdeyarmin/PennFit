// Hand-rolled fetch wrappers for the three Tier-2a clinical tabs on
// patient-detail: sleep studies, insurance coverages, prior auths.
// Bundled in one file because they share the same patient-scoped URL
// shape and the same project-as-camelCase pattern.

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
