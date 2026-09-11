// resolve-sku-entitlement.ts — DB-backed adapter around the pure
// resolveResupplyEntitlement domain function.
//
// Given a patient + an item SKU, it:
//   1. Resolves the SKU to a HCPCS family via the longest matching
//      prefix in resupply.sku_hcpcs_map (0171).
//   2. Loads the Medicare LCD L33718 replacement rule from
//      resupply.hcpcs_codes (min interval + per-period quantity cap).
//   3. Reads the patient's non-cancelled dispenses of that family from
//      resupply.fulfillments to derive the last-dispense date and the
//      quantity already shipped in the current rolling period.
//   4. Runs the pure entitlement decision.
//
// Returns `null` when the SKU can't be mapped to a known/active HCPCS
// family. Callers MUST treat `null` (and any thrown error) as "no
// opinion" → fail OPEN (allow the order). Blocking a confirmation we
// can't fully evaluate would strand a legitimate patient reorder.

import {
  resolveResupplyEntitlement,
  type ResupplyEntitlementResult,
} from "@workspace/resupply-domain";
import type { Database, ResupplySupabaseClient } from "@workspace/resupply-db";

export interface ResolveSkuEntitlementArgs {
  patientId: string;
  itemSku: string;
  /** Units being requested now. Defaults to 1 (the resupply confirm
   *  path ships a single unit per fulfillment row). */
  requestedQuantity?: number;
  /** Current moment; defaults to now. Tests pass a fixed instant. */
  now?: Date;
}

export type SkuEntitlement = ResupplyEntitlementResult & {
  hcpcsCode: string;
  skuPrefix: string;
  /** When this HCPCS family was last dispensed to the patient (newest
   *  non-cancelled fulfillment), or null if never. Surfaced so callers
   *  can derive the CMS refill window without re-querying fulfillments. */
  lastFulfilledAt: Date | null;
  /** The HCPCS replacement interval (= expected supply duration), used
   *  as the supply-duration input to the refill-window calculation. */
  minIntervalDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
type Tables = Database["resupply"]["Tables"];
type SkuMapping = Pick<
  Tables["sku_hcpcs_map"]["Row"],
  "sku_prefix" | "hcpcs_code"
>;

/** Classify every SKU independently: a more specific prefix can change
 * its family, and unrelated prefixes can still represent the same code. */
export function findSkuHcpcsMapping(itemSku: string, mappings: SkuMapping[]) {
  return mappings
    .filter((mapping) => itemSku.startsWith(mapping.sku_prefix))
    .sort((a, b) => b.sku_prefix.length - a.sku_prefix.length)[0];
}

export function groupFulfillmentsByHcpcs<Row extends { item_sku: string }>(
  rows: Row[],
  mappings: SkuMapping[],
) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const match = findSkuHcpcsMapping(row.item_sku, mappings);
    if (!match) continue;
    const family = groups.get(match.hcpcs_code) ?? [];
    family.push(row);
    groups.set(match.hcpcs_code, family);
  }
  return groups;
}

export async function resolveSkuEntitlement(
  supabase: ResupplySupabaseClient,
  args: ResolveSkuEntitlementArgs,
): Promise<SkuEntitlement | null> {
  const now = args.now ?? new Date();
  const requestedQuantity = args.requestedQuantity ?? 1;

  // 1. item_sku → HCPCS family (longest matching prefix). The map is a
  //    tiny reference table (~9 rows), so fetch it whole and match in
  //    memory rather than pushing a prefix predicate to PostgREST.
  const { data: mapRows, error: mapErr } = await supabase
    .schema("resupply")
    .from("sku_hcpcs_map")
    .select("sku_prefix, hcpcs_code");
  if (mapErr) throw mapErr;
  const match = findSkuHcpcsMapping(args.itemSku, mapRows ?? []);
  if (!match) return null;

  // 2. Load the replacement rule.
  const { data: hcpcs, error: hcpcsErr } = await supabase
    .schema("resupply")
    .from("hcpcs_codes")
    .select(
      "code, min_interval_days, max_quantity_per_period, period_days, active",
    )
    .eq("code", match.hcpcs_code)
    .maybeSingle();
  if (hcpcsErr) throw hcpcsErr;
  if (!hcpcs || hcpcs.active === false) return null;

  // 3. Classify history by HCPCS, not a raw prefix. MASK-FULL may map
  //    elsewhere than MASK, while a different manufacturer's prefix may
  //    share MASK's allowance. Walk every page so other supplies cannot
  //    displace the relevant family's last dispense or rolling quantity.
  const fulfillments: Pick<
    Tables["fulfillments"]["Row"],
    "item_sku" | "quantity" | "created_at"
  >[] = [];
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("fulfillments")
      .select("item_sku, quantity, created_at")
      .eq("patient_id", args.patientId)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + 199);
    if (error) throw error;
    fulfillments.push(...(data ?? []));
    if (!data || data.length < 200) break;
  }
  const families = groupFulfillmentsByHcpcs(fulfillments, mapRows ?? []);
  return calculateSkuEntitlement(
    match,
    hcpcs,
    families.get(match.hcpcs_code) ?? [],
    requestedQuantity,
    now,
  );
}

export function calculateSkuEntitlement(
  match: Pick<Tables["sku_hcpcs_map"]["Row"], "sku_prefix" | "hcpcs_code">,
  hcpcs: Pick<
    Tables["hcpcs_codes"]["Row"],
    "code" | "min_interval_days" | "max_quantity_per_period" | "period_days"
  >,
  rows: Pick<Tables["fulfillments"]["Row"], "quantity" | "created_at">[],
  requestedQuantity: number,
  now: Date,
): SkuEntitlement {
  const lastFulfilledAt =
    rows.length > 0 && rows[0]?.created_at
      ? new Date(rows[0].created_at)
      : null;

  const periodStart = now.getTime() - hcpcs.period_days * DAY_MS;
  const inPeriodRows = rows.filter(
    (r) =>
      r.created_at != null && new Date(r.created_at).getTime() >= periodStart,
  );
  const quantityInPeriod = inPeriodRows.reduce(
    (sum, r) => sum + (typeof r.quantity === "number" ? r.quantity : 1),
    0,
  );
  // Earliest dispense still inside the rolling period — lets the domain
  // engine date when the quantity cap next frees a unit (quantityEligibleOn).
  const earliestDispenseInPeriodAt =
    inPeriodRows.length > 0
      ? new Date(
          Math.min(
            ...inPeriodRows.map((r) =>
              new Date(r.created_at as string).getTime(),
            ),
          ),
        )
      : null;

  const result = resolveResupplyEntitlement({
    lastFulfilledAt,
    minIntervalDays: hcpcs.min_interval_days,
    maxQuantityPerPeriod: hcpcs.max_quantity_per_period,
    periodDays: hcpcs.period_days,
    quantityInPeriod,
    requestedQuantity,
    earliestDispenseInPeriodAt,
    now,
  });

  return {
    ...result,
    hcpcsCode: hcpcs.code,
    skuPrefix: match.sku_prefix,
    lastFulfilledAt,
    minIntervalDays: hcpcs.min_interval_days,
  };
}
