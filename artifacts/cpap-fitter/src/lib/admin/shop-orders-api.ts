// Hand-rolled fetch wrappers for the admin Shop Orders lookup +
// fulfillment-action endpoints (routes/admin/shop-orders.ts).
//
// Reuses the shared `adminJsonFetch` helper (prefixes `/resupply-api`,
// attaches the `pf_session` cookie + CSRF header, throws `ApiError` on
// non-OK). The browser sends the session cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export interface AdminShopOrderListItem {
  id: string;
  status: string;
  customerName: string | null;
  customerEmail: string | null;
  amountTotalCents: number | null;
  currency: string | null;
  createdAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  fulfillmentMethod: string | null;
  itemCount: number;
}

export interface AdminShopOrderListPage {
  orders: AdminShopOrderListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminShopOrderLineItem {
  name: string;
  quantity: number;
  amountSubtotalCents: number | null;
}

export interface AdminShopOrderDetail extends AdminShopOrderListItem {
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
  shippingAddress: unknown | null;
  lineItems: AdminShopOrderLineItem[];
}

export interface ListShopOrdersParams {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function listShopOrders(
  params?: ListShopOrdersParams,
): Promise<AdminShopOrderListPage> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.q) qs.set("q", params.q);
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.offset !== undefined) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return jsonFetch<AdminShopOrderListPage>(`/admin/shop/orders${suffix}`);
}

export function getShopOrder(orderId: string): Promise<AdminShopOrderDetail> {
  return jsonFetch<AdminShopOrderDetail>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}`,
  );
}

// Thin wrappers over the existing action endpoints already mounted in
// shop-orders.ts.

export function setShopOrderTracking(
  orderId: string,
  body: { carrier: string; number: string },
): Promise<unknown> {
  return jsonFetch<unknown>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/tracking`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function markShopOrderDelivered(orderId: string): Promise<unknown> {
  return jsonFetch<unknown>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/delivered`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function refundShopOrder(
  orderId: string,
  body: { reason?: string },
): Promise<unknown> {
  return jsonFetch<unknown>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/refund`,
    { method: "POST", body: JSON.stringify(body) },
  );
}
