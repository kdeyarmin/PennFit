// Loss-claim API wrappers (admin).

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export type LossClaimStatus =
  | "open"
  | "carrier_filed"
  | "resolved_refunded"
  | "resolved_reshipped"
  | "closed_unresolved";

export interface LossClaim {
  id: string;
  orderId: string;
  openedByUserId: string | null;
  status: LossClaimStatus;
  carrierClaimNumber: string | null;
  resolutionNote: string | null;
  openedAt: string;
  carrierFiledAt: string | null;
  resolvedAt: string | null;
}

export const listLossClaims = (orderId: string) =>
  jsonFetch<{ claims: LossClaim[] }>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/loss-claims`,
  );

export const openLossClaim = (orderId: string, note?: string) =>
  jsonFetch<{ id: string }>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/loss-claims`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    },
  );

export const patchLossClaim = (
  id: string,
  body: {
    status?: LossClaimStatus;
    carrierClaimNumber?: string | null;
    resolutionNote?: string | null;
  },
) =>
  jsonFetch<{ ok: true }>(`/admin/shop/loss-claims/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
