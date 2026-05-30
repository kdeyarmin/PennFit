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
import type { ResupplySupabaseClient } from "@workspace/resupply-db";

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
};

const DAY_MS = 24 * 60 * 60 * 1000;

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
  const match = (mapRows ?? [])
    .filter((r) => args.itemSku.startsWith(r.sku_prefix))
    .sort((a, b) => b.sku_prefix.length - a.sku_prefix.length)[0];
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

  // 3. The patient's non-cancelled dispenses of this family, newest
  //    first. Bounded at 200 — far more than any rolling period needs.
  const { data: fulfillments, error: fErr } = await supabase
    .schema("resupply")
    .from("fulfillments")
    .select("quantity, created_at, status")
    .eq("patient_id", args.patientId)
    .like("item_sku", `${match.sku_prefix}%`)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(200);
  if (fErr) throw fErr;
  const rows = fulfillments ?? [];

  const lastFulfilledAt =
    rows.length > 0 && rows[0]?.created_at
      ? new Date(rows[0].created_at)
      : null;

  const periodStart = now.getTime() - hcpcs.period_days * DAY_MS;
  const quantityInPeriod = rows
    .filter(
      (r) =>
        r.created_at != null && new Date(r.created_at).getTime() >= periodStart,
    )
    .reduce(
      (sum, r) => sum + (typeof r.quantity === "number" ? r.quantity : 1),
      0,
    );

  const result = resolveResupplyEntitlement({
    lastFulfilledAt,
    minIntervalDays: hcpcs.min_interval_days,
    maxQuantityPerPeriod: hcpcs.max_quantity_per_period,
    periodDays: hcpcs.period_days,
    quantityInPeriod,
    requestedQuantity,
    now,
  });

  return { ...result, hcpcsCode: hcpcs.code, skuPrefix: match.sku_prefix };
}
