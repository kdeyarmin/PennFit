// Fetch wrappers for the product catalog + warehouse stock
// (/resupply-api/admin/catalog/*).
//
// Auth flows over the `pf_session` cookie; mutations carry the CSRF header
// the admin middleware requires (see lib/csrf.ts).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface CatalogProduct {
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  unitOfMeasure: string;
  /** null = stock is not tracked for this SKU. */
  stockCount: number | null;
  lowStockThreshold: number | null;
  lowStock: boolean;
  active: boolean;
  updatedAt: string;
}

export type StockReason =
  | "receipt"
  | "dispense"
  | "return"
  | "count"
  | "adjustment";

export interface StockLedgerEntry {
  id: string;
  sku: string;
  delta: number;
  balanceAfter: number | null;
  reason: StockReason;
  reference: string | null;
  note: string | null;
  actorEmail: string | null;
  createdAt: string;
}

/**
 * Canonical admin catalog categories. Must stay in lockstep with
 * `SUPPLY_CATEGORIES` in `artifacts/resupply-api/src/lib/catalog/categories.ts`
 * — the live list endpoint returns that array, and the Add SKU form
 * offers whatever this GET puts in `categories`.
 */
export const SUPPLY_CATEGORIES = [
  "mask",
  "cushion",
  "headgear",
  "filter",
  "tubing",
  "humidifier",
  "machine",
  "accessory",
  "other",
] as const;

export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number];

export interface CatalogListResult {
  products: CatalogProduct[];
  total: number;
  categories: string[];
}

async function readJson<T>(res: Response, method: string, url: string) {
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

export interface CatalogListParams {
  q?: string;
  category?: string;
  includeInactive?: boolean;
  lowStockOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function fetchCatalog(
  params: CatalogListParams = {},
): Promise<CatalogListResult> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.category) qs.set("category", params.category);
  if (params.includeInactive) qs.set("includeInactive", "true");
  if (params.lowStockOnly) qs.set("lowStockOnly", "true");
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));

  const url = `/resupply-api/admin/catalog/products${
    qs.toString() ? `?${qs}` : ""
  }`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  return readJson<CatalogListResult>(res, "GET", url);
}

export async function fetchLowStock(): Promise<{ products: CatalogProduct[] }> {
  const url = "/resupply-api/admin/catalog/low-stock";
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  return readJson<{ products: CatalogProduct[] }>(res, "GET", url);
}

export async function fetchProduct(sku: string): Promise<{
  product: CatalogProduct;
  ledger: StockLedgerEntry[];
}> {
  const url = `/resupply-api/admin/catalog/products/${encodeURIComponent(sku)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  return readJson<{ product: CatalogProduct; ledger: StockLedgerEntry[] }>(
    res,
    "GET",
    url,
  );
}

export interface SaveProductInput {
  sku: string;
  name: string;
  description?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  unitOfMeasure?: string;
  lowStockThreshold?: number | null;
  active?: boolean;
  /** New SKUs only — an existing balance moves through adjustStock. */
  openingStock?: number | null;
}

export async function saveProduct(
  input: SaveProductInput,
): Promise<{ product: CatalogProduct }> {
  const url = "/resupply-api/admin/catalog/products";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  return readJson<{ product: CatalogProduct }>(res, "POST", url);
}

export async function adjustStock(
  sku: string,
  input: {
    delta: number;
    reason: StockReason;
    reference?: string | null;
    note?: string | null;
  },
): Promise<{ sku: string; stockCount: number | null }> {
  const url = `/resupply-api/admin/catalog/products/${encodeURIComponent(
    sku,
  )}/stock`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  return readJson<{ sku: string; stockCount: number | null }>(res, "POST", url);
}
