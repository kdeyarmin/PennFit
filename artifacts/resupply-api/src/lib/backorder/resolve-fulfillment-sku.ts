// Backorder-aware SKU resolution for the resupply order-flow.
//
// Contract
// --------
// Given the SKU the prescription wants to ship, return either:
//   * `{ sku: <primary>, substituted: false }` — primary is in
//     stock, ship as-is.
//   * `{ sku: <alternative>, substituted: true,
//        substitutedFromSku: <primary> }` — primary is backordered;
//     ship the first active alternative that isn't ALSO
//     backordered, ordered by priority asc.
//   * `{ sku: <primary>, substituted: false, noAlternative: true }`
//     — primary is backordered AND no in-stock alternative exists.
//     The caller MUST decide whether to insert a queued
//     fulfillment anyway (current behavior — surveys + manual
//     follow-up) or to raise an alert.
//
// Why this lives in lib (not inline in order-flow)
// ------------------------------------------------
// The helper is pure-ish (takes a supabase client + the rx SKU)
// and gets unit-tested via the supabase-mock helper. Inlining it
// inside ensureFulfillments would make that path hard to test.

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface ResolveResult {
  /** The SKU the caller should actually persist on the fulfillment row. */
  sku: string;
  /** True iff the caller should also stamp substituted_from_sku on the row. */
  substituted: boolean;
  /** The SKU the prescription asked for. Always equals the input. */
  substitutedFromSku?: string;
  /** True when primary is backordered but no in-stock alternative
   *  exists. Caller decides how to handle (today: ship primary
   *  anyway and let ops manually intervene). */
  noAlternative?: boolean;
}

/**
 * Resolve the fulfillment SKU. See module-level contract.
 *
 * One round-trip to `shop_backorders` for the primary; if it's
 * active, a second round-trip to `shop_sku_substitutes` (joined in
 * memory with the backorder set so an alternative can't itself be
 * backordered).
 */
export async function resolveFulfillmentSku(
  supabase: SupabaseClient,
  primarySku: string,
): Promise<ResolveResult> {
  // 1. Is primary backordered RIGHT NOW?
  const { data: primaryBackorder, error: primaryErr } = await supabase
    .schema("resupply")
    .from("shop_backorders")
    .select("id")
    .eq("sku", primarySku)
    .is("cleared_at", null)
    .limit(1)
    .maybeSingle();
  if (primaryErr) throw primaryErr;
  if (!primaryBackorder) {
    return { sku: primarySku, substituted: false };
  }

  // 2. Primary IS backordered. Walk the priority-ordered
  // alternatives and pick the first that isn't itself backordered.
  const { data: subs, error: subsErr } = await supabase
    .schema("resupply")
    .from("shop_sku_substitutes")
    .select("alternative_sku, priority")
    .eq("primary_sku", primarySku)
    .eq("active", true)
    .order("priority", { ascending: true })
    .limit(50);
  if (subsErr) throw subsErr;

  const alternatives = subs ?? [];
  if (alternatives.length === 0) {
    return {
      sku: primarySku,
      substituted: false,
      substitutedFromSku: primarySku,
      noAlternative: true,
    };
  }

  // Fetch the set of currently-backordered alternatives so we can
  // skip them in one pass.
  const altSkus = alternatives.map((a) => a.alternative_sku);
  const { data: backorderedAlts, error: altErr } = await supabase
    .schema("resupply")
    .from("shop_backorders")
    .select("sku")
    .in("sku", altSkus)
    .is("cleared_at", null);
  if (altErr) throw altErr;
  const blocked = new Set(
    (backorderedAlts ?? []).map((r) => r.sku),
  );

  const pick = alternatives.find((a) => !blocked.has(a.alternative_sku));
  if (!pick) {
    return {
      sku: primarySku,
      substituted: false,
      substitutedFromSku: primarySku,
      noAlternative: true,
    };
  }

  return {
    sku: pick.alternative_sku,
    substituted: true,
    substitutedFromSku: primarySku,
  };
}
