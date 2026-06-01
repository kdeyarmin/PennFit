// Loss-claim API wrappers (admin).

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(url, {
    ...restInit,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

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
