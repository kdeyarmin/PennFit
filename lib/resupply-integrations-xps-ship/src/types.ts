// Unified XPS Ship request/response types + Zod schemas.
//
// Only the fields PennFit actually reads are validated; XPS responses
// carry many more we ignore (`.passthrough()` everywhere we parse a
// vendor body so an added field never breaks the parse). Raw vendor
// bodies are never logged or persisted — the adapter returns these
// normalised summaries instead.

import { z } from "zod";

import type { XpsAddress } from "./config";

/** Normalised adapter error union (mirrors the other integrations). */
export type XpsError =
  | "auth_failed"
  | "not_found"
  | "rate_limited"
  | "invalid_request"
  | "unavailable"
  | "unknown_error";

/** A parcel to ship: weight (required) + optional dimensions. */
export interface XpsParcel {
  weightOz: number;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
}

export interface XpsQuoteInput {
  receiver: XpsAddress;
  parcels: XpsParcel[];
  /** Treat the receiver as a residential address (affects rates). */
  residential?: boolean;
  /** Optional filter: only quote this carrier (e.g. "ups", "usps"). */
  carrierCode?: string | null;
}

/** One rate option returned by the Quote endpoint. */
export interface XpsRate {
  carrierCode: string;
  serviceCode: string;
  serviceDescription: string;
  /** Total quoted price in cents. */
  totalCents: number;
  zone: string | null;
}

/** Input for staging a shippable order in XPS (Put Order). */
export interface XpsCreateOrderInput {
  /** Your stable order id — the lookup key for Search Shipments later. */
  orderId: string;
  orderNumber?: string | null;
  receiver: XpsAddress;
  parcels: XpsParcel[];
  /** Chosen service, e.g. "ups_ground". Omit to let XPS rules decide. */
  shippingService?: string | null;
  contentDescription?: string | null;
  /** Optional free-text references printed on the packing slip. */
  reference1?: string | null;
  reference2?: string | null;
}

/** A booked shipment resolved from XPS (Search/Retrieve Shipment). */
export interface XpsShipment {
  bookNumber: string;
  orderId: string | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  /** Booked label cost in cents, when XPS reported it. */
  totalCostCents: number | null;
}

/** A retrieved shipping label, ready to print. */
export interface XpsLabel {
  format: "PDF" | "PNG";
  /** Raw label bytes (PDF) or the first decoded PNG page. */
  bytes: Uint8Array;
  contentType: string;
}

// ── Vendor response schemas (lenient) ──────────────────────────────────

function dollarsToCents(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number.parseFloat(v) : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export const quoteResponseSchema = z
  .object({
    quotes: z
      .array(
        z
          .object({
            carrierCode: z.string(),
            serviceCode: z.string(),
            serviceDescription: z.string().optional(),
            totalAmount: z.union([z.string(), z.number()]).optional(),
            zone: z.union([z.string(), z.number()]).nullish(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export function parseRates(body: unknown): XpsRate[] {
  const parsed = quoteResponseSchema.safeParse(body);
  if (!parsed.success || !parsed.data.quotes) return [];
  return parsed.data.quotes.map((q) => ({
    carrierCode: q.carrierCode,
    serviceCode: q.serviceCode,
    serviceDescription: q.serviceDescription ?? q.serviceCode,
    totalCents: dollarsToCents(q.totalAmount) ?? 0,
    zone: q.zone == null ? null : String(q.zone),
  }));
}

const shipmentSchema = z
  .object({
    bookNumber: z.union([z.string(), z.number()]),
    orderId: z.union([z.string(), z.number()]).nullish(),
    trackingNumber: z.string().nullish(),
    carrierCode: z.string().nullish(),
    serviceCode: z.string().nullish(),
    totalShippingCost: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export function parseShipment(body: unknown): XpsShipment | null {
  const parsed = shipmentSchema.safeParse(body);
  if (!parsed.success) return null;
  const s = parsed.data;
  return {
    bookNumber: String(s.bookNumber),
    orderId: s.orderId == null ? null : String(s.orderId),
    trackingNumber: s.trackingNumber ?? null,
    carrierCode: s.carrierCode ?? null,
    serviceCode: s.serviceCode ?? null,
    totalCostCents: dollarsToCents(s.totalShippingCost),
  };
}

const searchResponseSchema = z
  .object({ shipments: z.array(shipmentSchema).optional() })
  .passthrough();

export function parseSearchShipments(body: unknown): XpsShipment[] {
  const parsed = searchResponseSchema.safeParse(body);
  if (!parsed.success || !parsed.data.shipments) return [];
  return parsed.data.shipments
    .map((s) => parseShipment(s as unknown as Record<string, unknown>))
    .filter((s): s is XpsShipment => s !== null);
}

const pngLabelSchema = z
  .object({
    labelImageFormat: z.string().optional(),
    base64Images: z.array(z.string()).optional(),
  })
  .passthrough();

export function parsePngLabel(body: unknown): Uint8Array | null {
  const parsed = pngLabelSchema.safeParse(body);
  const first = parsed.success ? parsed.data.base64Images?.[0] : undefined;
  if (!first) return null;
  return Uint8Array.from(Buffer.from(first, "base64"));
}
