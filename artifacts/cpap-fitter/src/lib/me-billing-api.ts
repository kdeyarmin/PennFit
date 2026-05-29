// Tiny typed client for /api/me/billing-balance + /api/me/payments +
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

export type PatientPaymentStatus =
  | "pending"
  | "requires_action"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "refunded";

export interface PatientPayment {
  id: string;
  amount_cents: number;
  currency: string;
  status: PatientPaymentStatus;
  applied_claims_json: Array<{
    claim_id: string;
    amount_applied_cents: number;
  }>;
  note: string | null;
  failure_reason: string | null;
  succeeded_at: string | null;
  created_at: string;
}

export interface PatientPaymentsResponse {
  payments: PatientPayment[];
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

/** Read the readable `pf_csrf` cookie (set at sign-in by the auth lib)
 *  and return it as an `X-PF-CSRF` header. The app-level conditional
 *  CSRF gate requires this header on every signed-in `/api/me/*`
 *  mutation (e.g. the checkout-session POST below); without it the
 *  request is rejected. Mirrors shop-api.ts's `csrfHeader()`. */
function csrfHeader(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const token = document.cookie
    .split("; ")
    .find((row) => row.startsWith("pf_csrf="))
    ?.slice("pf_csrf=".length);
  return token ? { "X-PF-CSRF": decodeURIComponent(token) } : {};
}

export function fetchBillingBalance(): Promise<BillingBalanceResponse> {
  return meGet<BillingBalanceResponse>("/me/billing-balance");
}

export function fetchPatientStatements(): Promise<PatientStatementsResponse> {
  return meGet<PatientStatementsResponse>("/me/billing-statements");
}

export function fetchPatientPayments(): Promise<PatientPaymentsResponse> {
  return meGet<PatientPaymentsResponse>("/me/payments");
}

/** Direct download URL for a statement PDF. Anchor `download` is
 *  the simplest path — the browser handles auth via the session
 *  cookie (mount is /api/me/billing-statements/:id/pdf). */
export function statementPdfUrl(statementId: string): string {
  return `/api/me/billing-statements/${statementId}/pdf`;
}

export interface CheckoutSessionResponse {
  paymentId: string;
  url: string;
  amountCents: number;
}

export interface CheckoutSessionAllocation {
  claimId: string;
  amountAppliedCents: number;
}

/** Create a Stripe Checkout Session for a balance payment. The
 *  caller should navigate the browser to the returned URL. The
 *  underlying patient_payments row is settled by the existing
 *  payment_intent.* webhook handler — no client confirmation step
 *  is needed. */
export async function createPaymentCheckoutSession(input: {
  allocations: CheckoutSessionAllocation[];
}): Promise<CheckoutSessionResponse> {
  const res = await fetch("/api/me/payments/checkout-session", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { message?: string; error?: string };
      detail = json.message ?? json.error ?? "";
    } catch {
      // ignore
    }
    throw new Error(
      detail || `Checkout session create failed (${res.status})`,
    );
  }
  return (await res.json()) as CheckoutSessionResponse;
}

export function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ─── Personalized cost estimate ─────────────────────────────────────

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
