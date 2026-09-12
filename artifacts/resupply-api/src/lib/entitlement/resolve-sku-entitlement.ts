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
// family. Lookup errors propagate: enforcement callers hold the order;
// metadata-only callers may omit the unavailable entitlement instead.

import {
  resolveResupplyEntitlement,
  type ResupplyEntitlementResult,
} from "@workspace/resupply-domain";
import type { Database, OrgScopedClient } from "@workspace/resupply-db";

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

/** PostgreSQL ARE pattern equivalent to the longest-prefix classifier.
 * Filter the family in SQL so aliases count together without reading
 * years of unrelated supplies. Escaping makes reference prefixes literal. */
export function hcpcsFamilyPattern(code: string, mappings: SkuMapping[]) {
  const literal = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const branches = mappings
    .filter((m) => m.hcpcs_code === code)
    .map((m) => {
      const exclusions = mappings
        .filter(
          (other) =>
            other.hcpcs_code !== code &&
            other.sku_prefix.startsWith(m.sku_prefix),
        )
        .map((other) => literal(other.sku_prefix.slice(m.sku_prefix.length)));
      return (
        literal(m.sku_prefix) +
        (exclusions.length ? `(?!(?:${exclusions.join("|")}))` : "")
      );
    });
  return branches.length ? `^(?:${branches.join("|")})` : "(?!)";
}

export async function resolveSkuEntitlement(
  supabase: OrgScopedClient,
  args: ResolveSkuEntitlementArgs,
): Promise<SkuEntitlement | null> {
  const now = args.now ?? new Date();
  const requestedQuantity = args.requestedQuantity ?? 1;

  // 1. item_sku → HCPCS family (longest matching prefix). The map is a
  //    tiny reference table (~9 rows), so fetch it whole and match in
  //    memory rather than pushing a prefix predicate to PostgREST.
  const { data: mapRows, error: mapErr } = await supabase
    .raw()
    .schema("resupply")
    .from("sku_hcpcs_map")
    .select("sku_prefix, hcpcs_code");
  if (mapErr) throw mapErr;
  const match = findSkuHcpcsMapping(args.itemSku, mapRows ?? []);
  if (!match) return null;

  // 2. Load the replacement rule.
  const { data: hcpcs, error: hcpcsErr } = await supabase
    .raw()
    .schema("resupply")
    .from("hcpcs_codes")
    .select(
      "code, min_interval_days, max_quantity_per_period, period_days, active",
    )
    .eq("code", match.hcpcs_code)
    .maybeSingle();
  if (hcpcsErr) throw hcpcsErr;
  if (!hcpcs || hcpcs.active === false) return null;

  // 3. Only the rolling quantity window needs all rows. ID keysets avoid
  //    duplicated/skipped rows when earlier records are added or cancelled
  //    during pagination. A latest-row fallback below preserves an older
  //    interval/refill anchor without loading lifetime history.
  const periodDays = Number.isFinite(hcpcs.period_days)
    ? Math.max(0, hcpcs.period_days)
    : 0;
  const periodStart = new Date(
    now.getTime() - periodDays * DAY_MS,
  ).toISOString();
  const familyPattern = hcpcsFamilyPattern(match.hcpcs_code, mapRows ?? []);
  const historyQuery = () =>
    supabase
      .from("fulfillments")
      .select("id, item_sku, quantity, created_at")
      .eq("patient_id", args.patientId)
      .neq("status", "cancelled")
      .filter("item_sku", "match", familyPattern)
      .lte("created_at", now.toISOString());
  const fulfillments: Pick<
    Tables["fulfillments"]["Row"],
    "id" | "item_sku" | "quantity" | "created_at"
  >[] = [];
  let afterId: string | undefined;
  for (;;) {
    let query = historyQuery()
      .gte("created_at", periodStart)
      .order("id")
      .limit(200);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw error;
    fulfillments.push(...(data ?? []));
    if (!data || data.length < 200) break;
    const nextId = data[data.length - 1]?.id;
    if (!nextId || (afterId && nextId <= afterId))
      throw new Error("Entitlement history cursor did not advance");
    afterId = nextId;
  }
  if (!fulfillments.length) {
    const { data, error } = await historyQuery()
      .lt("created_at", periodStart)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1);
    if (error) throw error;
    fulfillments.push(...(data ?? []));
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
  let lastFulfilledAt: Date | null = null;
  for (const row of rows) {
    const at = new Date(row.created_at);
    if (!Number.isFinite(at.getTime())) {
      lastFulfilledAt = at; // preserve the domain's invalid-date guard
      break;
    }
    if (!lastFulfilledAt || at > lastFulfilledAt) lastFulfilledAt = at;
  }

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
