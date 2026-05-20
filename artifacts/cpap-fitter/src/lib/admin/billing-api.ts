// Hand-rolled fetch wrappers for the /admin/billing/* endpoints.
//
// Mirrors the pattern used by today-api.ts and other admin-API
// libraries in this folder — keep the SPA decoupled from any
// generated client and let TypeScript carry the response shapes.
//
// All endpoints assume `pf_session` cookie auth. No PHI crosses these
// boundaries; per-patient drill-in still goes through the existing
// /admin/patients/:id/insurance-claims surface.

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
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const json = (await res.json()) as { message?: string; error?: string };
      detail = json.message ?? json.error;
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

export interface EraIngestResponse {
  eraFileId: string;
  status: string;
  summary: {
    claimsMatched?: number;
    claimsUnmatched?: number;
    linesProcessed?: number;
    totalPaidCents?: number;
    [key: string]: unknown;
  };
}

export function ingestEraFile(input: {
  fileName: string;
  payload: string;
  matchedSubmissionId?: string | null;
}): Promise<EraIngestResponse> {
  return postJSON<EraIngestResponse>("/admin/billing/era-ingest", input);
}

// ─── Format helpers ─────────────────────────────────────────────────

export function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
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
