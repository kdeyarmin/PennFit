// Product catalog reads + writes.
//
// The catalog moved out of Stripe when patient card payments were retired
// (migration 0520). Everything here goes through the ORG-SCOPED facade, so
// a tenant only ever sees its own SKUs and inserts carry `org_id`
// automatically.
//
// Stock is deliberately NOT writable through this module's upsert path:
// on-hand only moves via `adjustStock`, which calls the
// `adjust_product_stock` RPC so the update and its ledger row are one
// atomic, serialized unit. A plain UPDATE from here would lose a
// concurrent decrement and leave the ledger disagreeing with the balance.

import {
  getOrgScopedClient,
  type Database,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import { DEFAULT_LOW_STOCK_THRESHOLD } from "./categories";

export type ProductRow = Database["resupply"]["Tables"]["products"]["Row"];
export type StockLedgerRow =
  Database["resupply"]["Tables"]["product_stock_ledger"]["Row"];
export type StockReason = StockLedgerRow["reason"];

/** Catalog row as the admin UI consumes it. */
export interface ProductView {
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  unitOfMeasure: string;
  /** null = stock is not tracked for this SKU. */
  stockCount: number | null;
  /** Effective reorder point; null when the SKU is untracked. */
  lowStockThreshold: number | null;
  /** True only for a TRACKED SKU at or below its reorder point. */
  lowStock: boolean;
  active: boolean;
  updatedAt: string;
}

export function projectProduct(row: ProductRow): ProductView {
  const threshold =
    row.stock_count === null
      ? null
      : (row.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD);
  return {
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    manufacturer: row.manufacturer,
    modelNumber: row.model_number,
    unitOfMeasure: row.unit_of_measure,
    stockCount: row.stock_count,
    lowStockThreshold: threshold,
    // An untracked SKU is never "low" — we have no number to compare, and
    // warning on it would train operators to ignore the badge.
    lowStock:
      row.stock_count !== null &&
      threshold !== null &&
      row.stock_count <= threshold,
    active: row.active,
    updatedAt: row.updated_at,
  };
}

export interface ListProductsOptions {
  /** Substring match on SKU or name (case-insensitive). */
  search?: string | null;
  category?: string | null;
  /** Omit to list active only; pass true to include archived rows. */
  includeInactive?: boolean;
  /** Only SKUs at or below their reorder point. */
  lowStockOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listProducts(
  orgId: string,
  opts: ListProductsOptions = {},
): Promise<{ products: ProductView[]; total: number }> {
  const db = getOrgScopedClient(orgId);
  let q = db
    .from("products")
    .select("*", { count: "exact" })
    .order("name", { ascending: true });

  if (!opts.includeInactive) q = q.eq("active", true);
  if (opts.category) q = q.eq("category", opts.category);
  if (opts.search) {
    // Escape PostgREST's `or` filter metacharacters so a search for
    // "N30i,mask" can't smuggle an extra condition into the expression.
    const safe = opts.search.replace(/[(),*]/g, " ").trim();
    if (safe) q = q.or(`sku.ilike.*${safe}*,name.ilike.*${safe}*`);
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;

  let products = ((data ?? []) as ProductRow[]).map(projectProduct);
  // Low-stock is a derived comparison against a defaulted threshold, so it
  // can't be expressed as a PostgREST filter without duplicating the
  // default in SQL. Filter after projection; the page bound above keeps
  // the set small.
  if (opts.lowStockOnly) products = products.filter((p) => p.lowStock);

  return { products, total: count ?? products.length };
}

export async function getProduct(
  orgId: string,
  sku: string,
): Promise<ProductView | null> {
  const { data, error } = await getOrgScopedClient(orgId)
    .from("products")
    .select("*")
    .eq("sku", sku)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? projectProduct(data as ProductRow) : null;
}

export interface UpsertProductInput {
  sku: string;
  name: string;
  description?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  unitOfMeasure?: string;
  lowStockThreshold?: number | null;
  active?: boolean;
  /**
   * Opening on-hand for a NEW SKU only. Ignored when the SKU already
   * exists — an existing balance moves through `adjustStock` so the change
   * lands in the ledger. `null` (or omitted) creates the SKU untracked.
   */
  openingStock?: number | null;
}

/**
 * Create a SKU, or update its descriptive fields. Never moves stock on an
 * existing row (see `openingStock`). Returns the resulting row.
 */
export async function upsertProduct(
  orgId: string,
  input: UpsertProductInput,
  actorEmail: string | null,
): Promise<ProductView> {
  const db = getOrgScopedClient(orgId);
  const existing = await getProduct(orgId, input.sku);

  const fields = {
    name: input.name,
    description: input.description ?? null,
    category: input.category ?? null,
    manufacturer: input.manufacturer ?? null,
    model_number: input.modelNumber ?? null,
    unit_of_measure: input.unitOfMeasure ?? "each",
    low_stock_threshold: input.lowStockThreshold ?? null,
    active: input.active ?? true,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await db
      .from("products")
      .update(fields)
      .eq("sku", input.sku)
      .select("*")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`products row vanished for sku=${input.sku}`);
    return projectProduct(data as ProductRow);
  }

  const opening = input.openingStock ?? null;
  const { data, error } = await db
    .from("products")
    .insert({ sku: input.sku, ...fields, stock_count: opening })
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new Error(`products insert returned no row for ${input.sku}`);

  // Record the opening balance so the ledger explains the number from the
  // very first movement rather than starting mid-story.
  if (opening !== null && opening > 0) {
    await writeLedgerRow(db, {
      sku: input.sku,
      delta: opening,
      balanceAfter: opening,
      reason: "count",
      note: "Opening balance",
      actorEmail,
    });
  }

  return projectProduct(data as ProductRow);
}

export class UnknownSkuError extends Error {}
export class InsufficientStockError extends Error {}

export interface AdjustStockInput {
  sku: string;
  /** Signed; negative dispenses. Must be non-zero. */
  delta: number;
  reason: StockReason;
  reference?: string | null;
  note?: string | null;
}

/**
 * Move stock through the `adjust_product_stock` RPC, which serializes
 * concurrent callers for the SKU and writes the ledger row in the same
 * transaction. Returns the new on-hand count, or null when the SKU is
 * untracked (the movement is still recorded).
 *
 * Throws {@link UnknownSkuError} when the SKU isn't catalogued and
 * {@link InsufficientStockError} when the movement would go negative, so
 * callers can tell "typo" from "we're out" without parsing SQLSTATE.
 */
export async function adjustStock(
  orgId: string,
  input: AdjustStockInput,
  actorEmail: string | null,
): Promise<number | null> {
  const { data, error } = await getOrgScopedClient(orgId)
    .raw()
    .schema("resupply")
    .rpc("adjust_product_stock", {
      p_org_id: orgId,
      p_sku: input.sku,
      p_delta: input.delta,
      p_reason: input.reason,
      p_reference: input.reference ?? null,
      p_note: input.note ?? null,
      p_actor_email: actorEmail,
    });

  if (error) {
    const msg = error.message ?? "";
    if (/unknown sku/i.test(msg)) throw new UnknownSkuError(msg);
    if (/negative/i.test(msg)) throw new InsufficientStockError(msg);
    throw error;
  }
  return (data as number | null) ?? null;
}

async function writeLedgerRow(
  db: OrgScopedClient,
  row: {
    sku: string;
    delta: number;
    balanceAfter: number | null;
    reason: StockReason;
    note?: string | null;
    actorEmail: string | null;
  },
): Promise<void> {
  const { error } = await db.from("product_stock_ledger").insert({
    sku: row.sku,
    delta: row.delta,
    balance_after: row.balanceAfter,
    reason: row.reason,
    note: row.note ?? null,
    actor_email: row.actorEmail,
  });
  if (error) throw error;
}

export interface LedgerEntry {
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

export async function listStockLedger(
  orgId: string,
  sku: string,
  limit = 50,
): Promise<LedgerEntry[]> {
  const { data, error } = await getOrgScopedClient(orgId)
    .from("product_stock_ledger")
    .select("*")
    .eq("sku", sku)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw error;
  return ((data ?? []) as StockLedgerRow[]).map((r) => ({
    id: r.id,
    sku: r.sku,
    delta: r.delta,
    balanceAfter: r.balance_after,
    reason: r.reason,
    reference: r.reference,
    note: r.note,
    actorEmail: r.actor_email,
    createdAt: r.created_at,
  }));
}

/**
 * Every ACTIVE SKU whose stock is tracked. Unpaged on purpose: the digest
 * job has to see the whole set to tell a SKU that recovered from one it
 * simply never reached, and a supply catalog is dozens of rows, not
 * thousands.
 */
export async function listTrackedProducts(
  orgId: string,
): Promise<ProductView[]> {
  const { data, error } = await getOrgScopedClient(orgId)
    .from("products")
    .select("*")
    .eq("active", true)
    .not("stock_count", "is", null);
  if (error) throw error;
  return ((data ?? []) as ProductRow[]).map(projectProduct);
}

/**
 * Tracked SKUs at or below their reorder point, worst first. Backs both
 * the admin low-stock view and the digest job.
 */
export async function listLowStock(orgId: string): Promise<ProductView[]> {
  return (await listTrackedProducts(orgId))
    .filter((p) => p.lowStock)
    .sort((a, b) => (a.stockCount ?? 0) - (b.stockCount ?? 0));
}
