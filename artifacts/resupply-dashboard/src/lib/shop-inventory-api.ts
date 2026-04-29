// Hand-rolled fetch wrappers for the shop inventory admin endpoints.
//
// Mirrors `shop-reviews-api.ts` exactly (same auth bridge pattern,
// same hand-rolled choice rationale): the v1 inventory endpoint is
// not in the OpenAPI spec yet because the surface is still tiny
// (one PATCH against Stripe metadata). We list products via the
// PUBLIC catalog endpoint — there is no admin-only "list shop
// products" endpoint and there doesn't need to be: the admin sees
// the same SKUs the storefront does, plus the live `stockCount`
// projection that already drops out of the public response.
//
// Auth bridge: same Clerk → Authorization header bridge as
// shop-reviews-api.ts. The list call is technically public, but
// sending the bearer token on it is a no-op (the public endpoint
// doesn't read it), so we do it for free symmetry.

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

// Subset of `ShopProductView` from products-meta.ts that the
// inventory editor actually renders. Kept hand-typed (vs imported
// from the api package) because the API isn't exposing a TS type
// over the workspace boundary yet — and the inventory editor only
// needs five fields, so the duplication cost is tiny.
export interface InventoryProductRow {
  id: string;
  name: string;
  category: string;
  priceCents: number | null;
  currency: string | null;
  stockCount: number | null;
  /**
   * Per-SKU "Only N left" threshold (null → storefront uses default
   * of 5). Editable from the admin inventory page; written via
   * PATCH /admin/shop/products/:id/threshold.
   */
  lowStockThreshold: number | null;
}

export interface ListShopInventoryResponse {
  previewMode: boolean;
  products: InventoryProductRow[];
}

export async function listShopInventory(): Promise<ListShopInventoryResponse> {
  const res = await fetch("/resupply-api/shop/products", {
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) {
    // 503 here means "Stripe is not configured" — which the public
    // endpoint already handles by returning the preview catalog
    // (so we should never reach this branch in practice). Surface
    // a clear error if Stripe is down some other way.
    throw new Error(`Failed to load inventory (${res.status})`);
  }
  // Field shapes mirror artifacts/resupply-api/src/lib/stripe/products-meta.ts
  // ShopProductView. The price object uses `unitAmount` (cents,
  // matching Stripe's `unit_amount`), not `amount` — guard against
  // both names defensively in case a future API revision renames
  // back, but `unitAmount` is the only shape currently emitted.
  const json = (await res.json()) as {
    previewMode?: boolean;
    products?: Array<{
      id: string;
      name: string;
      category: string;
      price?: {
        unitAmount?: number | null;
        amount?: number | null;
        currency: string | null;
      };
      stockCount?: number | null;
      lowStockThreshold?: number | null;
    }>;
  };
  return {
    previewMode: json.previewMode ?? false,
    products: (json.products ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      priceCents: p.price?.unitAmount ?? p.price?.amount ?? null,
      currency: p.price?.currency ?? null,
      stockCount: p.stockCount ?? null,
      lowStockThreshold: p.lowStockThreshold ?? null,
    })),
  };
}

export async function patchShopProductStock(
  productId: string,
  stockCount: number | null,
): Promise<InventoryProductRow> {
  const res = await fetch(
    `/resupply-api/admin/shop/products/${encodeURIComponent(productId)}/stock`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ stockCount }),
    },
  );
  if (res.status === 503) {
    // Preview / dev: Stripe isn't configured, so there's nothing to
    // write. Surface a typed error the page can render as an
    // explainer banner instead of a generic toast.
    throw new InventoryUnavailableError("stripe_not_configured");
  }
  if (!res.ok) {
    throw new Error(`Save failed (${res.status})`);
  }
  // Same shape as listShopInventory's response object (one product
  // here vs an array there). The API uses `price.unitAmount`
  // (mirrors Stripe's `unit_amount`); the `amount` fallback keeps
  // the parse robust if a future API revision renames back. Without
  // both names, a successful save would replace the row's price
  // cell with "—" — a real functional drift, not just a cosmetic one.
  const json = (await res.json()) as {
    product: {
      id: string;
      name: string;
      category: string;
      price?: {
        unitAmount?: number | null;
        amount?: number | null;
        currency: string | null;
      };
      stockCount?: number | null;
      lowStockThreshold?: number | null;
    };
  };
  return {
    id: json.product.id,
    name: json.product.name,
    category: json.product.category,
    priceCents:
      json.product.price?.unitAmount ?? json.product.price?.amount ?? null,
    currency: json.product.price?.currency ?? null,
    stockCount: json.product.stockCount ?? null,
    lowStockThreshold: json.product.lowStockThreshold ?? null,
  };
}

// PATCH the per-SKU low-stock threshold via Stripe metadata (A15).
// Mirrors `patchShopProductStock` exactly: same auth bridge, same
// 503 handling, same row-shape contract. Threshold of `null` clears
// the metadata key; the storefront then falls back to the default 5.
export async function patchShopProductThreshold(
  productId: string,
  lowStockThreshold: number | null,
): Promise<InventoryProductRow> {
  const res = await fetch(
    `/resupply-api/admin/shop/products/${encodeURIComponent(productId)}/threshold`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ lowStockThreshold }),
    },
  );
  if (res.status === 503) {
    throw new InventoryUnavailableError("stripe_not_configured");
  }
  if (!res.ok) {
    throw new Error(`Save failed (${res.status})`);
  }
  const json = (await res.json()) as {
    product: {
      id: string;
      name: string;
      category: string;
      price?: {
        unitAmount?: number | null;
        amount?: number | null;
        currency: string | null;
      };
      stockCount?: number | null;
      lowStockThreshold?: number | null;
    };
  };
  return {
    id: json.product.id,
    name: json.product.name,
    category: json.product.category,
    priceCents:
      json.product.price?.unitAmount ?? json.product.price?.amount ?? null,
    currency: json.product.price?.currency ?? null,
    stockCount: json.product.stockCount ?? null,
    lowStockThreshold: json.product.lowStockThreshold ?? null,
  };
}

// Bulk stock-count save (A4). Implemented as parallel PATCH calls
// against the existing single-SKU endpoint — Stripe's API is the
// rate-limit ceiling, and at ~30 SKUs the worst case is well under
// any per-second cap. We deliberately don't batch on the server:
// the existing PATCH already does the catalog-membership guard
// per-call, an audit log line lands per save, and a single failure
// doesn't roll back the others (we surface a per-row result).
export interface BulkStockResultItem {
  productId: string;
  ok: boolean;
  product?: InventoryProductRow;
  error?: string;
}

export async function bulkPatchShopProductStock(
  updates: ReadonlyArray<{ productId: string; stockCount: number | null }>,
): Promise<BulkStockResultItem[]> {
  const results = await Promise.all(
    updates.map(async (u): Promise<BulkStockResultItem> => {
      try {
        const product = await patchShopProductStock(u.productId, u.stockCount);
        return { productId: u.productId, ok: true, product };
      } catch (err) {
        return {
          productId: u.productId,
          ok: false,
          error:
            err instanceof InventoryUnavailableError
              ? "Stripe is not configured."
              : err instanceof Error
                ? err.message
                : "Save failed",
        };
      }
    }),
  );
  return results;
}

export class InventoryUnavailableError extends Error {
  constructor(public readonly reason: "stripe_not_configured") {
    super(reason);
    this.name = "InventoryUnavailableError";
  }
}
