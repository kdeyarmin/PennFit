// Admin client for per-order shipment evidence.
//
// PacWare ships out of band and, until the shipment import existed,
// nothing ever told the app an order had left. These two calls are the
// manual half of closing that loop: a tenant with no PacWare feed records
// shipments here, and a tenant that has one uses them to correct a single
// row without re-importing a file.

import { adminJsonFetch } from "../admin-json-fetch";

export interface MarkShippedRequest {
  /** YYYY-MM-DD. Becomes the claim's date of service, so it must be the
   *  real ship date — the server rejects a future date and anything more
   *  than 180 days old. */
  shippedAt: string;
  deliveredAt?: string | null;
  trackingNumber?: string;
  carrier?: string;
  pacwareOrderRef?: string;
}

export interface MarkShippedResponse {
  status: "applied" | "already_recorded";
  episodeClosed: boolean;
  nextEpisodeId: string | null;
  nextEpisodeCreated: boolean;
  reanchored: boolean;
}

export type CancelFulfillmentReason =
  | "csr_canceled"
  | "duplicate"
  | "patient_inactive"
  | "coverage_lost";

export function markFulfillmentShipped(
  fulfillmentId: string,
  body: MarkShippedRequest,
): Promise<MarkShippedResponse> {
  return adminJsonFetch<MarkShippedResponse>(
    `/admin/fulfillments/${encodeURIComponent(fulfillmentId)}/mark-shipped`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function cancelFulfillment(
  fulfillmentId: string,
  reason: CancelFulfillmentReason,
): Promise<{ status: string; episodeClosed: boolean }> {
  return adminJsonFetch<{ status: string; episodeClosed: boolean }>(
    `/admin/fulfillments/${encodeURIComponent(fulfillmentId)}/cancel`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}
