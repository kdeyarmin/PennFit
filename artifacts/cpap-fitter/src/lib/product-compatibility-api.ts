// Hand-rolled fetch wrappers for the product compatibility lookup
// endpoints shipped in Phase B.3. Used by the catalog filter +
// the product-detail "Compatible with your machine" badge.

export interface ProductCompatibilityEntry {
  id: string;
  machineManufacturer: string;
  machineModel: string | null;
  notes: string | null;
}

export interface ProductCompatibilityResponse {
  compatibility: ProductCompatibilityEntry[];
}

export interface CompatibilityForMachineResponse {
  /** Product IDs that have a compat row matching the requested machine. */
  explicitCompatibleProductIds: string[];
  /** Product IDs that have ANY compat row. Anything NOT in this
   *  set is universal (no compat constraints) and should be shown
   *  unfiltered. */
  constrainedProductIds: string[];
}

export async function fetchProductCompatibility(
  productId: string,
): Promise<ProductCompatibilityResponse> {
  const res = await fetch(
    `/resupply-api/shop/products/${encodeURIComponent(productId)}/compatibility`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Failed to load compatibility (${res.status})`);
  }
  return (await res.json()) as ProductCompatibilityResponse;
}

export async function fetchCompatibilityForMachine(
  input: { manufacturer: string; model?: string | null },
  signal?: AbortSignal,
): Promise<CompatibilityForMachineResponse> {
  const qs = new URLSearchParams();
  qs.set("manufacturer", input.manufacturer);
  if (input.model) qs.set("model", input.model);
  const res = await fetch(
    `/resupply-api/shop/products/compatibility?${qs.toString()}`,
    { headers: { Accept: "application/json" }, signal },
  );
  if (!res.ok) {
    throw new Error(`Failed to load compatibility filter (${res.status})`);
  }
  return (await res.json()) as CompatibilityForMachineResponse;
}

/**
 * Precomputes the two Sets from a CompatibilityForMachineResponse and
 * returns a stable predicate that accepts a product id. Build once per
 * fetch; pass the returned function into the catalog filter so the Sets
 * aren't re-allocated on every render cycle.
 */
export function buildCompatibilityFilter(
  compat: CompatibilityForMachineResponse,
): (productId: string) => boolean {
  const explicit = new Set(compat.explicitCompatibleProductIds);
  const constrained = new Set(compat.constrainedProductIds);
  return (id) => explicit.has(id) || !constrained.has(id);
}

/**
 * Client-side filter helper. Given the response from
 * fetchCompatibilityForMachine + a list of products, returns the
 * subset that are explicitly compatible OR universal.
 */
export function filterByCompatibility<T extends { id: string }>(
  products: T[],
  compat: CompatibilityForMachineResponse,
): T[] {
  const predicate = buildCompatibilityFilter(compat);
  return products.filter((p) => predicate(p.id));
}
