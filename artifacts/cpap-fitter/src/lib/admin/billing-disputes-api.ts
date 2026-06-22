// Hand-rolled fetch wrapper for the admin chargeback-dispute worklist
// (GET /admin/billing/disputes). Same rationale as the other v1 admin api
// wrappers (referral-sources-api.ts): not in the OpenAPI spec.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

export interface StripeDisputeRow {
  id: string;
  stripeDisputeId: string;
  stripeChargeId: string | null;
  orderId: string | null;
  amountCents: number;
  currency: string;
  reason: string | null;
  status: string | null;
  evidenceDueBy: string | null;
  openedAt: string | null;
  closedAt: string | null;
  outcome: string | null;
}

export interface DisputesResponse {
  disputes: StripeDisputeRow[];
}

// The server returns snake_case columns straight from PostgREST; map to the
// camelCase shape the page renders.
interface RawDisputeRow {
  id: string;
  stripe_dispute_id: string;
  stripe_charge_id: string | null;
  order_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string | null;
  status: string | null;
  evidence_due_by: string | null;
  opened_at: string | null;
  closed_at: string | null;
  outcome: string | null;
}

async function readJsonOrThrow<T>(
  res: Response,
  method: string,
  url: string,
): Promise<T> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body — leave data null
  }
  if (!res.ok) {
    throw new ApiError(res, data, { method, url });
  }
  return data as T;
}

export async function getBillingDisputes(
  status: "open" | "all" = "open",
): Promise<DisputesResponse> {
  const url = `/resupply-api/admin/billing/disputes?status=${encodeURIComponent(
    status,
  )}`;
  const res = await fetch(url, { credentials: "same-origin" });
  const raw = await readJsonOrThrow<{ disputes: RawDisputeRow[] }>(
    res,
    "GET",
    url,
  );
  return {
    disputes: (raw.disputes ?? []).map((d) => ({
      id: d.id,
      stripeDisputeId: d.stripe_dispute_id,
      stripeChargeId: d.stripe_charge_id,
      orderId: d.order_id,
      amountCents: d.amount_cents,
      currency: d.currency,
      reason: d.reason,
      status: d.status,
      evidenceDueBy: d.evidence_due_by,
      openedAt: d.opened_at,
      closedAt: d.closed_at,
      outcome: d.outcome,
    })),
  };
}
