// Typed fetch wrappers for the auto-submit worklist:
//   - GET  /admin/billing/auto-submit/ready    — claims ready to transmit
//   - GET  /admin/billing/auto-submit/status    — automation status banner
//   - POST /admin/billing/auto-submit/run       — operator approve & submit
//
// Mirrors office-ally-api.ts: typed shapes, ApiError on non-2xx, cookie
// auth + CSRF header on the mutation. No PHI lingers past the render.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...csrfHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as T;
}

export type ExclusionReason =
  | "no_payer_profile"
  | "no_coverage"
  | "eligibility_missing"
  | "eligibility_inactive"
  | "eligibility_stale"
  | "preflight_blocked";

export interface ReadyClaim {
  claimId: string;
  patientId: string;
  patientName: string;
  payerProfileId: string;
  payerName: string;
  totalBilledCents: number;
  dateOfService: string | null;
  eligibilityVerifiedAt: string;
}

export interface ReadyGroup {
  payerProfileId: string;
  payerName: string;
  claimCount: number;
  totalBilledCents: number;
  claims: ReadyClaim[];
}

export interface ExcludedClaim {
  claimId: string;
  patientId: string;
  reason: ExclusionReason;
  detail: string;
}

export interface SubmissionReadiness {
  groups: ReadyGroup[];
  readyClaimCount: number;
  readyPayerCount: number;
  readyTotalBilledCents: number;
  excluded: ExcludedClaim[];
  scannedCount: number;
  generatedAt: string;
}

export function fetchAutoSubmitReady(
  maxClaims?: number,
): Promise<SubmissionReadiness> {
  const qs = maxClaims != null ? `?maxClaims=${maxClaims}` : "";
  return getJSON(`/admin/billing/auto-submit/ready${qs}`);
}

export interface AutoSubmitStatus {
  autoSubmit: {
    flagEnabled: boolean;
    cronConfigured: boolean;
    cronExpression: string | null;
    active: boolean;
    maxClaimsPerRun: number;
    maxClaimsPerBatch: number;
  };
  eligibilityAutoReverify: {
    cronConfigured: boolean;
    cronExpression: string | null;
  };
}

export function fetchAutoSubmitStatus(): Promise<AutoSubmitStatus> {
  return getJSON("/admin/billing/auto-submit/status");
}

export interface AutoSubmitRunResult {
  triggeredBy: "operator" | "cron";
  batchesAttempted: number;
  claimsSubmitted: number;
  submissions: Array<{
    submissionId: string;
    payerProfileId: string;
    claimCount: number;
    uploadOk: boolean;
    isaControlNumber: string;
  }>;
  failures: Array<{ payerProfileId: string; kind: string }>;
  skippedNotReady: string[];
  readyClaimCount: number;
}

export function runAutoSubmit(body?: {
  claimIds?: string[];
  maxClaims?: number;
}): Promise<AutoSubmitRunResult> {
  return postJSON("/admin/billing/auto-submit/run", body ?? {});
}

const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  no_payer_profile: "No payer profile",
  no_coverage: "No coverage linked",
  eligibility_missing: "No eligibility on file",
  eligibility_inactive: "Coverage inactive",
  eligibility_stale: "Eligibility stale",
  preflight_blocked: "Preflight blocked",
};

export function exclusionLabel(reason: ExclusionReason): string {
  return EXCLUSION_LABELS[reason] ?? reason;
}
