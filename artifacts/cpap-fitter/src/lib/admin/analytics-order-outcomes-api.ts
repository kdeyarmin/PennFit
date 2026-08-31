// Fetch wrapper for /admin/analytics/order-outcomes — the first surface
// that joins the resupply funnel to the money.
//
// Everything before a claim was measured on one page and everything after
// it on another, with nothing connecting them. The route returns camelCase
// already.

import { ApiError } from "@workspace/api-client-react/admin";

export const ORDER_OUTCOME_STAGES = [
  "eligible",
  "confirmed",
  "fulfilled",
  "claimed",
  "accepted",
  "paid",
] as const;

export type OrderOutcomeStage = (typeof ORDER_OUTCOME_STAGES)[number];

export interface OrderOutcomesResponse {
  days: number;
  stages: Record<OrderOutcomeStage, number>;
  /** `null` where the denominator was zero — "no data", not "0%". */
  rates: {
    confirmedOfEligible: number | null;
    fulfilledOfConfirmed: number | null;
    claimedOfFulfilled: number | null;
    acceptedOfClaimed: number | null;
    paidOfAccepted: number | null;
  };
  /** Keyed by `episodes.closed_reason`; `legacy_unknown` for cycles closed
   *  before that column existed. */
  preShipLoss: Record<string, number>;
  postShipLoss: {
    unbilled: number;
    denied: number;
    rejected: number;
    closedUnpaid: number;
  };
  inFlight: {
    awaitingResponse: number;
    confirmedUnshipped: number;
    addressHold: number;
    claimOpen: number;
  };
  deniedByCarc: Array<{ code: string; count: number; description: string }>;
}

export async function fetchOrderOutcomes(
  days = 30,
): Promise<OrderOutcomesResponse> {
  const url = `/resupply-api/admin/analytics/order-outcomes?days=${days}`;
  const res = await fetch(url, {
    credentials: "include",
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
  return (await res.json()) as OrderOutcomesResponse;
}
