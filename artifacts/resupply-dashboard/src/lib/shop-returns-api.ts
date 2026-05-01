// Hand-rolled fetch wrappers for the admin shop-returns endpoints.
// Mirrors shop-reviews-api.ts — the v1 returns surface is not yet in
// the OpenAPI spec; promote it once the workflow stabilizes.

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export type ReturnStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "shipped_back"
  | "received"
  | "refunded"
  | "replaced"
  | "closed";

export type ReturnReason =
  | "fit"
  | "defective"
  | "wrong_item"
  | "no_longer_needed"
  | "other";

export type ReturnResolution = "refund" | "exchange" | "store_credit" | null;

export interface AdminReturn {
  id: string;
  clerkUserId: string;
  orderId: string;
  sessionId: string;
  status: ReturnStatus;
  reason: ReturnReason;
  reasonNote: string | null;
  resolution: ReturnResolution;
  refundCents: number | null;
  stripeRefundId: string | null;
  exchangeProductId: string | null;
  exchangePriceId: string | null;
  exchangeOrderId: string | null;
  returnLabelUrl: string | null;
  returnCarrier: string | null;
  returnTrackingNumber: string | null;
  adminNote: string | null;
  adminClerkId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  shippedBackAt: string | null;
  receivedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
}

export interface AdminReturnListResponse {
  returns: AdminReturn[];
  nextCursor: string | null;
}

const BASE = "/resupply-api/admin/shop/returns";

export async function listAdminShopReturns(params: {
  status: ReturnStatus | "all" | "open";
  cursor?: string;
  limit?: number;
}): Promise<AdminReturnListResponse> {
  const qs = new URLSearchParams();
  qs.set("status", params.status);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  const res = await fetch(`${BASE}?${qs.toString()}`, {
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`Failed to load returns (${res.status})`);
  return (await res.json()) as AdminReturnListResponse;
}

export async function approveReturn(id: string, body: {
  note?: string;
  returnLabelUrl?: string | null;
  returnCarrier?: string | null;
  returnTrackingNumber?: string | null;
}): Promise<{ return: AdminReturn }> {
  return action(id, "approve", body);
}

export async function rejectReturn(id: string, note?: string) {
  return action(id, "reject", { note });
}

export async function markShipped(id: string, note?: string) {
  return action(id, "mark-shipped", { note });
}

export async function markReceived(id: string, note?: string) {
  return action(id, "mark-received", { note });
}

export async function refundReturn(id: string, body: { amountCents?: number; note?: string }) {
  return action(id, "refund", body);
}

export async function replaceReturn(id: string, body: {
  exchangeProductId: string;
  exchangePriceId: string;
  exchangeOrderId?: string | null;
  note?: string;
}) {
  return action(id, "replace", body);
}

export async function noteReturn(id: string, note: string) {
  return action(id, "note", { note });
}

async function action(
  id: string,
  verb: string,
  body: Record<string, unknown>,
): Promise<{ return: AdminReturn }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/${verb}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Action failed (${res.status})`);
  }
  return (await res.json()) as { return: AdminReturn };
}
