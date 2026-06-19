// Hand-rolled fetch wrappers for the XPS Ship shipping-label endpoints
// (/admin/shipping/xps/* + /admin/shop/orders/:id/shipping/*). Same
// pattern as pacware-api.ts / integrations-status-api.ts.

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
      "Content-Type": "application/json",
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

export type XpsAvailability =
  | { status: "configured" }
  | { status: "stub"; reason: "no_credentials" | "incomplete_config" };

export interface XpsStatus {
  availability: XpsAvailability;
}

export interface XpsQueueOrder {
  id: string;
  createdAt: string;
  amountTotalCents: number | null;
  labelStatus: "staged" | "booked" | "voided" | null;
  shipTo: string | null;
  hasAddress: boolean;
}

export interface XpsRate {
  carrierCode: string;
  serviceCode: string;
  serviceDescription: string;
  totalCents: number;
  zone: string | null;
}

/** Parcel the operator weighs/measures. Weight is in OUNCES. */
export interface ParcelSpec {
  weightOz: number;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
}

export type LabelResult =
  | {
      status: "booked";
      carrier: string;
      trackingNumber: string;
      bookNumber: string;
    }
  | { status: "staged"; note?: string };

export const getXpsStatus = () =>
  jsonFetch<XpsStatus>("/admin/shipping/xps/status");

export const getXpsQueue = (limit = 50) =>
  jsonFetch<{ orders: XpsQueueOrder[] }>(
    `/admin/shipping/xps/queue?limit=${encodeURIComponent(String(limit))}`,
  );

export const getXpsRates = (
  orderId: string,
  body: {
    parcel: ParcelSpec;
    residential?: boolean;
    carrierCode?: string | null;
  },
) =>
  jsonFetch<{ rates: XpsRate[] }>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/shipping/rates`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const createXpsLabel = (
  orderId: string,
  body: {
    parcel: ParcelSpec;
    residential?: boolean;
    shippingService: string;
    contentDescription?: string | null;
  },
) =>
  jsonFetch<LabelResult>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/shipping/label`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const syncXpsLabel = (orderId: string) =>
  jsonFetch<LabelResult>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/shipping/sync`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const voidXpsLabel = (orderId: string) =>
  jsonFetch<{ status: "voided" }>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/shipping/void`,
    { method: "POST", body: JSON.stringify({}) },
  );

/** The printable-label URL — open in a new tab; cookies authenticate it. */
export const xpsLabelPdfUrl = (orderId: string) =>
  `/resupply-api/admin/shop/orders/${encodeURIComponent(orderId)}/shipping/label.pdf`;
