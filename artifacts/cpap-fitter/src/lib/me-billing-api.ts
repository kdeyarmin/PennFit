import { csrfHeader } from "./csrf";

// Tiny typed client for /api/me/billing-balance +
// /api/me/billing-statements. Patterned on account-api.ts but keeps
// scope narrow: read-only patient-portal queries plus the
// statement-PDF download URL.
//
// The /api/me/* surfaces all gate on the shop-customer session
// cookie (`credentials: "include"` puts it on the wire). The mounted
// path is /api/* — NOT /resupply-api/* — see
// artifacts/resupply-api/src/app.ts:380 for the mount.

export interface OpenBalanceClaim {
  id: string;
  payerName: string;
  dateOfService: string | null;
  patientResponsibilityCents: number;
}

export interface BillingBalanceResponse {
  totalOpenCents: number;
  claimCount: number;
  claims: OpenBalanceClaim[];
}

export interface PatientStatement {
  id: string;
  totalPatientResponsibilityCents: number;
  lineItemCount: number;
  deliveryMethod: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface PatientStatementsResponse {
  statements: PatientStatement[];
}

async function meGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function fetchBillingBalance(): Promise<BillingBalanceResponse> {
  return meGet<BillingBalanceResponse>("/me/billing-balance");
}

export function fetchPatientStatements(): Promise<PatientStatementsResponse> {
  return meGet<PatientStatementsResponse>("/me/billing-statements");
}

/** Direct download URL for a statement PDF. Anchor `download` is
 *  the simplest path — the browser handles auth via the session
 *  cookie (mount is /api/me/billing-statements/:id/pdf). */
export function statementPdfUrl(statementId: string): string {
  return `/api/me/billing-statements/${statementId}/pdf`;
}

// ─── Statement delivery preference (emailed vs mailed) ──────────────

export type StatementDeliveryMethod = "email" | "mail";

export interface StatementPreferenceResponse {
  statementDeliveryMethod: StatementDeliveryMethod;
  email: string | null;
  /** False when the account isn't linked to a patient billing record. */
  linked?: boolean;
}

export function fetchStatementPreference(): Promise<StatementPreferenceResponse> {
  return meGet<StatementPreferenceResponse>("/me/statement-preferences");
}

export async function updateStatementPreference(
  statementDeliveryMethod: StatementDeliveryMethod,
): Promise<StatementPreferenceResponse> {
  const res = await fetch("/api/me/statement-preferences", {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify({ statementDeliveryMethod }),
  });
  if (!res.ok) {
    throw new Error(`Update statement preference failed (${res.status})`);
  }
  return (await res.json()) as StatementPreferenceResponse;
}

export function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface MeClaimSummary {
  id: string;
  payerName: string | null;
  dateOfService: string | null;
  status: string;
  totalBilledCents: number | null;
  totalPaidCents: number | null;
  patientResponsibilityCents: number;
  submittedAt: string | null;
  decisionAt: string | null;
  paidAt: string | null;
}

export interface MeClaimLineItem {
  hcpcsCode: string | null;
  modifier: string | null;
  description: string | null;
  quantity: number;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  status: string;
}

export interface MeClaimEvent {
  eventType: string;
  amountCents: number | null;
  payerRef: string | null;
  note: string | null;
  occurredAt: string;
}

export interface MeClaimDetail {
  claim: MeClaimSummary & { denialReason: string | null };
  lineItems: MeClaimLineItem[];
  events: MeClaimEvent[];
}

/** The signed-in patient's claims — each claim is the unit a charge +
 *  its credits hang off of. */
export function fetchClaims(): Promise<{ claims: MeClaimSummary[] }> {
  return meGet<{ claims: MeClaimSummary[] }>("/me/claims");
}

/** Charge/credit detail for one claim: billed line items (charges) +
 *  the claim event log (payer payments, adjustments = credits). */
export function fetchClaimDetail(claimId: string): Promise<MeClaimDetail> {
  return meGet<MeClaimDetail>(`/me/claims/${encodeURIComponent(claimId)}`);
}

export type PersonalEstimateResponse =
  | { available: false }
  | {
      available: true;
      payerName: string | null;
      isActive: boolean | null;
      inNetwork: boolean | null;
      deductibleCents: number | null;
      deductibleMetCents: number | null;
      oopMaxCents: number | null;
      oopMetCents: number | null;
      copayCents: number | null;
      coinsurancePct: number | null;
      requiresPriorAuth: boolean | null;
      asOf: string | null;
    };

/** Returns the signed-in patient's most-recent parsed 270/271
 *  financials, or `{ available: false }` if there's no parsed check
 *  on file (either no eligibility check was run, the patient isn't
 *  linked to a shop customer, or the call is unauthenticated). The
 *  call is intentionally tolerant — a 401 also resolves as
 *  `{ available: false }` so the page can fall back to the static
 *  estimator without forcing a sign-in redirect. */
export async function fetchPersonalEstimate(): Promise<PersonalEstimateResponse> {
  try {
    const res = await fetch("/api/me/insurance-estimate", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { available: false };
    return (await res.json()) as PersonalEstimateResponse;
  } catch {
    return { available: false };
  }
}

// ─── Payment methods + autopay (card on file) ───────────────────────
