// Hand-rolled fetch wrappers for the XPS Ship shipping-label endpoints
// (/admin/shipping/xps/* + /admin/shop/orders/:id/shipping/*). Same
// pattern as pacware-api.ts / integrations-status-api.ts.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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
  addressValid: boolean;
}

export interface SuggestedParcel {
  weightOz: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  fromPresets: boolean;
  missingProductIds: string[];
}

export interface ProductSpec {
  productId: string;
  weightOz: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  label: string | null;
}

export interface BatchLabelResult {
  results: Array<{
    orderId: string;
    status: "booked" | "staged" | "error";
    trackingNumber?: string;
    carrier?: string;
    error?: string;
  }>;
  summary: { booked: number; staged: number; errored: number };
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

export const getSuggestedParcel = (orderId: string) =>
  jsonFetch<SuggestedParcel>(
    `/admin/shop/orders/${encodeURIComponent(orderId)}/shipping/suggested-parcel`,
  );

export const batchCreateXpsLabels = (body: {
  orderIds: string[];
  shippingService: string;
  residential?: boolean;
}) =>
  jsonFetch<BatchLabelResult>("/admin/shipping/xps/batch-label", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getXpsProductSpecs = () =>
  jsonFetch<{ specs: ProductSpec[]; unconfiguredProductIds: string[] }>(
    "/admin/shipping/xps/product-specs",
  );

export const saveXpsProductSpecs = (specs: ProductSpec[]) =>
  jsonFetch<{ ok: true; count: number }>("/admin/shipping/xps/product-specs", {
    method: "PUT",
    body: JSON.stringify({ specs }),
  });

/** The printable-label URL — open in a new tab; cookies authenticate it. */
export const xpsLabelPdfUrl = (orderId: string) =>
  `/resupply-api/admin/shop/orders/${encodeURIComponent(orderId)}/shipping/label.pdf`;
