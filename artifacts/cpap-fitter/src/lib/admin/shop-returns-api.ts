// Hand-rolled fetch wrappers for the admin shop-returns endpoints.
// Mirrors shop-reviews-api.ts — the v1 returns surface is not yet in
// the OpenAPI spec; promote it once the workflow stabilizes.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

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
  customerId: string;
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
  adminUserId: string | null;
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

/**
 * The timestamp at which a return entered its CURRENT admin-actionable
 * state — i.e. how long it's been waiting on US, not on the customer.
 * Returns null for states that aren't waiting on the admin: `approved`
 * (waiting on the customer to ship the item back) and every terminal
 * state. Used to surface an aging/"waiting N days" badge in the queue so
 * the longest-waiting customers don't sink past the page fold.
 */
export function returnActionableSince(item: {
  status: ReturnStatus;
  createdAt: string;
  shippedBackAt: string | null;
  receivedAt: string | null;
}): string | null {
  switch (item.status) {
    case "requested":
      return item.createdAt;
    case "shipped_back":
      // Fall back to createdAt if the transition timestamp is somehow
      // missing, so the badge still renders rather than disappearing.
      return item.shippedBackAt ?? item.createdAt;
    case "received":
      return item.receivedAt ?? item.createdAt;
    default:
      return null;
  }
}

/**
 * Whole days between `sinceIso` and `nowMs`, floored, never negative.
 * Returns 0 for an unparseable or future timestamp so the UI degrades to
 * "today" rather than rendering NaN.
 */
export function waitingDays(sinceIso: string, nowMs: number): number {
  const since = new Date(sinceIso).getTime();
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, Math.floor((nowMs - since) / 86_400_000));
}

const BASE = "/resupply-api/admin/shop/returns";

export async function listAdminShopReturns(params: {
  status: ReturnStatus | "all" | "open" | "needs_action";
  cursor?: string;
  limit?: number;
}): Promise<AdminReturnListResponse> {
  const qs = new URLSearchParams();
  qs.set("status", params.status);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  const url = `${BASE}?${qs.toString()}`;
  const res = await fetch(url, {
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
  return (await res.json()) as AdminReturnListResponse;
}

export async function approveReturn(
  id: string,
  body: {
    note?: string;
    returnLabelUrl?: string | null;
    returnCarrier?: string | null;
    returnTrackingNumber?: string | null;
  },
): Promise<{ return: AdminReturn }> {
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

export async function refundReturn(
  id: string,
  body: { amountCents?: number; note?: string },
) {
  return action(id, "refund", body);
}

export async function replaceReturn(
  id: string,
  body: {
    exchangeProductId: string;
    exchangePriceId: string;
    exchangeOrderId?: string | null;
    note?: string;
  },
) {
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
  const url = `${BASE}/${encodeURIComponent(id)}/${verb}`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as { return: AdminReturn };
}
