// Hand-rolled fetch wrappers for the /admin/billing/* endpoints.
//
// Mirrors the pattern used by today-api.ts and other admin-API
// libraries in this folder — keep the SPA decoupled from any
// generated client and let TypeScript carry the response shapes.
//
// All endpoints assume `pf_session` cookie auth. No PHI crosses these
// boundaries; per-patient drill-in still goes through the existing
// /admin/patients/:id/insurance-claims surface.

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`Failed to load ${path} (${res.status})`);
  }
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const json = (await res.json()) as {
        message?: string;
        error?: string;
        issues?: Array<{ path?: string; message?: string }>;
      };
      // Field-level validation responses (`{ error: "invalid_body",
      // issues: [...] }`) carry the actually-actionable detail in
      // `issues`, not `message`. Surface the first issue (or all of
      // them, comma-separated) so operators see "fileName: required"
      // instead of "invalid_body".
      if (Array.isArray(json.issues) && json.issues.length > 0) {
        detail = json.issues
          .map((i) =>
            i.path ? `${i.path}: ${i.message ?? "invalid"}` : i.message,
          )
          .filter(Boolean)
          .join("; ");
      } else {
        detail = json.message ?? json.error;
      }
    } catch {
      // ignore — fall back to status text
    }
    throw new Error(
      detail
        ? `${path} failed (${res.status}): ${detail}`
        : `${path} failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

// ─── Director summary ───────────────────────────────────────────────

export interface DirectorSummaryResponse {
  counts: {
    staleDrafts: number;
    freshDenials: number;
    stuckSubmittedNoAck: number;
    partialEras: number;
    scrubBlocking: number;
    scrubFixable: number;
    deniedNeedsAnalysis: number;
    autoResubmitReady: number;
    webhooksQueued: number;
    webhooksExhausted24h: number;
  };
  dollars: {
    stuckSubmittedCents: number;
    deniedFreshCents: number;
    patientResponsibilityCents: number;
  };
  denialRateTrend: Array<{
    window: "d0_30" | "d30_60" | "d60_90";
    decisions: number;
    denials: number;
    denialRate: number | null;
  }>;
  topPayersByOpenDollars: Array<{
    payerName: string;
    openCents: number;
  }>;
  generatedAt: string;
}

export function fetchDirectorSummary(): Promise<DirectorSummaryResponse> {
  return getJSON<DirectorSummaryResponse>("/admin/billing/director-summary");
}

// ─── AI work queue ──────────────────────────────────────────────────

export interface ClaimQueueItem {
  id: string;
  patientId: string;
  payerName: string;
  totalBilledCents: number | null;
  latestScrubAt?: string | null;
  latestScrubResultId?: string | null;
  decisionAt?: string | null;
  denialReason?: string | null;
}

export interface AutoResubmitReadyItem {
  analysisId: string;
  claimId: string;
  /** Resolved via JOIN to insurance_claims so the SPA can deep-link
   *  into the per-patient claim workbench without an extra fetch. */
  patientId: string | null;
  recommendation: string;
  confidence: number | null;
  rootCauseSummary: string | null;
  createdAt: string;
}

export interface AiQueueResponse {
  scrubBlockingClaims: ClaimQueueItem[];
  scrubFixableClaims: ClaimQueueItem[];
  deniedNeedsAnalysis: ClaimQueueItem[];
  autoResubmitReady: AutoResubmitReadyItem[];
  counts: {
    scrubBlocking: number;
    scrubFixable: number;
    deniedNeedsAnalysis: number;
    autoResubmitReady: number;
  };
  generatedAt: string;
}

export function fetchAiQueue(): Promise<AiQueueResponse> {
  return getJSON<AiQueueResponse>("/admin/billing/ai-queue");
}

// ─── Aging report ───────────────────────────────────────────────────

export type AgingBucketKey = "0_30" | "31_60" | "61_90" | "90_plus";

export interface AgingBucketCounts {
  claimCount: number;
  billedCents: number;
}

export type AgingBuckets = Record<AgingBucketKey, AgingBucketCounts>;

export interface AgingReportResponse {
  overall: AgingBuckets;
  perPayer: Array<{ payerName: string; buckets: AgingBuckets }>;
  totalOpenBilledCents: number;
  totalOpenClaimCount: number;
  generatedAt: string;
}

export function fetchAgingReport(): Promise<AgingReportResponse> {
  return getJSON<AgingReportResponse>("/admin/billing/aging-report");
}

// ─── Denial rate ────────────────────────────────────────────────────

export interface DenialRateResponse {
  overall: {
    decisions: number;
    denials: number;
    denialRate: number | null;
  };
  perPayer: Array<{
    payerName: string;
    decisions: number;
    denials: number;
    denialRate: number | null;
  }>;
  windowDays: number;
  generatedAt: string;
}

export function fetchDenialRate(): Promise<DenialRateResponse> {
  return getJSON<DenialRateResponse>("/admin/billing/denial-rate");
}

// ─── DSO by payer ───────────────────────────────────────────────────

export interface DsoByPayerResponse {
  payers: Array<{
    payerName: string;
    claimCount: number;
    totalPaidCents: number;
    averageDaysToPay: number | null;
  }>;
  windowDays: number;
  generatedAt: string;
}

export function fetchDsoByPayer(): Promise<DsoByPayerResponse> {
  return getJSON<DsoByPayerResponse>("/admin/billing/dso-by-payer");
}

// ─── ERA files ──────────────────────────────────────────────────────

export interface EraFile {
  id: string;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number | null;
  payerCheckNumber: string | null;
  payerPaidDate: string | null;
  totalPaidCents: number | null;
  claimsPaidCount: number | null;
  claimsDeniedCount: number | null;
  linesProcessedCount: number | null;
  matchedSubmissionId: string | null;
  status: string;
  rejectionReason: string | null;
  ingestedByEmail: string | null;
  ingestedAt: string;
}

export interface EraFilesResponse {
  eraFiles: EraFile[];
}

export function fetchEraFiles(): Promise<EraFilesResponse> {
  return getJSON<EraFilesResponse>("/admin/billing/era-files");
}

/** Mirror of `ReconciliationSummary` from
 *  artifacts/resupply-api/src/lib/billing/era-reconciler.ts. The
 *  field names match the actual API payload — `matchedClaims` etc,
 *  NOT `linesProcessed`/`totalPaidCents`. */
export interface EraIngestSummary {
  matchedClaims: number;
  unmatchedClaims: number;
  linesUpdated: number;
  paidClaims: number;
  deniedClaims: number;
  outcomes: Array<{
    patientControlNumber: string;
    matched: boolean;
    newStatus: string | null;
    paidCents: number;
    patientResponsibilityCents: number;
    denialReason: string | null;
  }>;
}

export interface EraIngestResponse {
  eraFileId: string;
  /** era_files.status — "processed" when every claim matched,
   *  "partial" when some did not, "rejected" on parser failure. */
  status: "processed" | "partial" | "rejected";
  summary: EraIngestSummary;
}

export function ingestEraFile(input: {
  fileName: string;
  payload: string;
  matchedSubmissionId?: string | null;
}): Promise<EraIngestResponse> {
  return postJSON<EraIngestResponse>("/admin/billing/era-ingest", input);
}

// ─── Eligibility (system-wide recent) ───────────────────────────────

export type EligibilityStatus =
  | "queued"
  | "submitted"
  | "parsed"
  | "rejected"
  | "transport_failed";

export interface EligibilityCheck {
  id: string;
  patientId: string;
  insuranceCoverageId: string;
  payerProfileId: string | null;
  payerName: string | null;
  serviceHcpcs: string | null;
  status: EligibilityStatus;
  isActive: boolean | null;
  inNetwork: boolean | null;
  deductibleCents: number | null;
  deductibleMetCents: number | null;
  oopMaxCents: number | null;
  oopMetCents: number | null;
  copayCents: number | null;
  coinsurancePct: number | null;
  requiresPriorAuth: boolean | null;
  errorMessage: string | null;
  requestedAt: string;
  respondedAt: string | null;
}

export interface EligibilityRecentResponse {
  checks: EligibilityCheck[];
  counts: {
    total: number;
    byStatus: Record<EligibilityStatus, number>;
    activeCoverage: number;
    inactiveCoverage: number;
    priorAuthFlagged: number;
  };
  windowDays: number;
  generatedAt: string;
}

export function fetchEligibilityRecent(params?: {
  status?: EligibilityStatus;
  days?: number;
  limit?: number;
}): Promise<EligibilityRecentResponse> {
  const search = new URLSearchParams();
  if (params?.status) search.set("status", params.status);
  if (params?.days) search.set("days", String(params.days));
  if (params?.limit) search.set("limit", String(params.limit));
  const qs = search.toString();
  return getJSON<EligibilityRecentResponse>(
    `/admin/billing/eligibility-recent${qs ? `?${qs}` : ""}`,
  );
}

// ─── Prior-auth queue (system-wide) ─────────────────────────────────

export type PriorAuthStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "denied"
  | "appealed"
  | "expired";

export type McoSlaStatus = "on_track" | "at_risk" | "missed" | "decided";

export interface PriorAuthRow {
  id: string;
  patientId: string;
  payerName: string;
  hcpcsCode: string;
  status: PriorAuthStatus;
  authNumber: string | null;
  submittedAt: string | null;
  decisionAt: string | null;
  approvedThrough: string | null;
  mcoSlaStatus: McoSlaStatus | null;
  mcoSlaTargetDate: string | null;
  daysToTarget: number | null;
  daysToExpiry: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriorAuthQueueResponse {
  atRisk: PriorAuthRow[];
  missed: PriorAuthRow[];
  awaiting: PriorAuthRow[];
  expiringSoon: PriorAuthRow[];
  drafts: PriorAuthRow[];
  counts: {
    atRisk: number;
    missed: number;
    awaiting: number;
    expiringSoon: number;
    drafts: number;
  };
  expiringWithinDays: number;
  generatedAt: string;
}

export function fetchPriorAuthQueue(params?: {
  expiringWithinDays?: number;
  limit?: number;
}): Promise<PriorAuthQueueResponse> {
  const search = new URLSearchParams();
  if (params?.expiringWithinDays)
    search.set("expiringWithinDays", String(params.expiringWithinDays));
  if (params?.limit) search.set("limit", String(params.limit));
  const qs = search.toString();
  return getJSON<PriorAuthQueueResponse>(
    `/admin/billing/prior-auth-queue${qs ? `?${qs}` : ""}`,
  );
}

// ─── Format helpers ─────────────────────────────────────────────────

export function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(
  fraction: number | null | undefined,
  digits = 1,
): string {
  if (fraction == null || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}
