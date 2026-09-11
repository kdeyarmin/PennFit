import type { Database, OrgScopedClient } from "@workspace/resupply-db";
import {
  calculateSkuEntitlement,
  findSkuHcpcsMapping,
  groupFulfillmentsByHcpcs,
  type SkuEntitlement,
} from "./resolve-sku-entitlement";
type Tables = Database["resupply"]["Tables"];
type Fill = Pick<
  Tables["fulfillments"]["Row"],
  "item_sku" | "quantity" | "created_at" | "shipped_at"
>;

/** Load shared reference data and patient history once for every active SKU. */
export async function loadPatientSupplySummary(
  db: OrgScopedClient,
  patientId: string,
  itemSkus: string[],
  now = new Date(),
) {
  const entitlements = new Map<string, SkuEntitlement | null>();
  const lastOrderedAt = new Map<string, string>();
  const lastSuppliedAt = new Map<string, string>();
  if (!itemSkus.length) return { entitlements, lastOrderedAt, lastSuppliedAt };
  // These two tables are global HCPCS references; all patient rows below
  // use the tenant wrapper and an explicit patient filter.
  const [mappings, codes] = await Promise.all([
    db
      .raw()
      .schema("resupply")
      .from("sku_hcpcs_map")
      .select("sku_prefix, hcpcs_code"),
    db
      .raw()
      .schema("resupply")
      .from("hcpcs_codes")
      .select(
        "code, min_interval_days, max_quantity_per_period, period_days, active",
      )
      .eq("active", true),
  ]);
  if (mappings.error) throw mappings.error;
  if (codes.error) throw codes.error;
  const fills: Fill[] = [];
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await db
      .from("fulfillments")
      .select("item_sku, quantity, created_at, shipped_at")
      .eq("patient_id", patientId)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + 199);
    if (error) throw error;
    fills.push(...(data ?? []));
    if (!data || data.length < 200) break;
  }
  for (const f of fills) {
    if (!lastOrderedAt.has(f.item_sku))
      lastOrderedAt.set(f.item_sku, f.created_at);
    const at = f.shipped_at ?? f.created_at;
    if (!lastSuppliedAt.has(f.item_sku) || at > lastSuppliedAt.get(f.item_sku)!)
      lastSuppliedAt.set(f.item_sku, at);
  }
  const families = groupFulfillmentsByHcpcs(fills, mappings.data ?? []);
  for (const sku of new Set(itemSkus)) {
    const match = findSkuHcpcsMapping(sku, mappings.data ?? []);
    const code =
      match && (codes.data ?? []).find((c) => c.code === match.hcpcs_code);
    entitlements.set(
      sku,
      match && code
        ? calculateSkuEntitlement(
            match,
            code,
            families.get(match.hcpcs_code) ?? [],
            1,
            now,
          )
        : null,
    );
  }
  return { entitlements, lastOrderedAt, lastSuppliedAt };
}
