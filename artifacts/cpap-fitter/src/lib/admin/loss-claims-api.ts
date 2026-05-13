// Loss-claim API wrappers (admin).

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
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
