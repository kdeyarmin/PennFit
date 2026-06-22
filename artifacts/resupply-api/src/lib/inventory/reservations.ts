// Inventory reservation / oversell guard for the cash-pay checkout.
//
// THE GAP THIS CLOSES
// -------------------
// Shop stock lives in Stripe product metadata as `stock_count`
// (point-in-time). `validateCartItems` (lib/stripe/validate-cart.ts) reads it
// at session-creation time, and the paid webhook decrements it. Between those
// two events there is no concurrency control: N concurrent buyers can each
// pass validateCart against the SAME live `stock_count`, all create Checkout
// sessions, and all complete → oversell.
//
// A short-lived reservation ledger (migration 0434) closes the window. Each
// buyer reserves their requested units up front, in the same request that
// passed validateCart; the `reserve_inventory` RPC serializes concurrent
// reservers per (org, sku) and counts existing live holds against the live
// `stock_count`, so a second concurrent buyer is refused if granting their
// hold would oversell. The hold is consumed on payment, released on
// cancel/expire, and swept to `expired` once stale.
//
// FAIL-OPEN — the cardinal rule of this module
// ---------------------------------------------
// A reservation-system error must NEVER block a sale. The worst case if this
// module is wholly bypassed is the pre-existing oversell behaviour, which is
// reconciled by the monthly inventory count. So:
//   * `reserveCartInventory` returns `{ ok: true, reservationIds: [] }` on
//     ANY thrown error (Stripe down, RPC error, DB unreachable). The checkout
//     proceeds unguarded, exactly as it did before this feature existed.
//   * It returns `{ ok: false }` ONLY when the RPC cleanly reports that a
//     specific SKU is oversold — a real, healthy-system "out of stock".
//   * attach / consume / release / expire are best-effort and swallow their
//     own errors (logged, never thrown) so a leaked hold self-heals via TTL +
//     the sweep cron rather than 500-ing a checkout or a webhook.
//
// PHI / logging: order bodies are PHI. This module logs ids and counts only.
// `sku` is the Stripe PRODUCT id (the stock unit — `stock_count` is product
// metadata and a product can carry more than one price line).

import type Stripe from "stripe";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { parseStockCount } from "../stripe/products-meta";

/** Default reservation TTL: 15 minutes (Stripe Checkout sessions expire at
 *  ~24h, but a hold only needs to cover the realistic "decide + pay" window;
 *  a leaked hold past this point is swept to `expired` and frees the stock). */
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface ReservationCartItem {
  priceId: string;
  quantity: number;
  mode: "one_time" | "subscription";
}

export interface ReserveCartInventoryInput {
  orgId: string;
  stripe: Stripe;
  /** Per-request Stripe options ({ stripeAccount } for connected tenants).
   *  MUST match the account validateCart ran against, or every price lookup
   *  404s and the guard silently fails open. */
  requestOptions?: Stripe.RequestOptions;
  items: ReservationCartItem[];
  ttlMs?: number;
  log?: ReservationLogger;
}

export type ReserveCartInventoryResult =
  | { ok: true; reservationIds: string[] }
  | { ok: false; oversoldProductId: string };

interface ReservationLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Reserve stock for every stock-tracked one-time item in the cart.
 *
 * For each one_time line we resolve the Stripe product id + its live
 * `stock_count` (same retrieve-with-product-expanded shape validateCart
 * uses). Quantities are aggregated per product across duplicate lines (a
 * product can appear on more than one line, mirroring validateCart's
 * split-line defence). Untracked products (`stock_count` null = unlimited)
 * are skipped. Subscription lines are never reserved — recurring stock is not
 * modelled.
 *
 * On a clean "oversold" verdict from the RPC we release every hold collected
 * so far (so a partial reservation never leaks) and return `{ ok: false }`.
 * On ANY thrown error we FAIL OPEN: release nothing we can't account for,
 * log a warning, and return `{ ok: true, reservationIds: [] }` so checkout
 * proceeds unguarded.
 */
export async function reserveCartInventory(
  input: ReserveCartInventoryInput,
): Promise<ReserveCartInventoryResult> {
  const {
    orgId,
    stripe,
    requestOptions = {},
    items,
    ttlMs = DEFAULT_RESERVATION_TTL_MS,
    log,
  } = input;

  try {
    // Aggregate requested quantity per PRODUCT (not price) for one-time
    // lines — stock is tracked per product, and a product can be reached via
    // more than one price line, so summing per product is what prevents a
    // split-line bypass (two lines of qty=3 each against stock=5).
    const qtyByProduct = new Map<string, { qty: number; stockCount: number }>();

    // Resolve each unique one-time priceId once.
    const oneTimePriceIds = new Set<string>();
    for (const item of items) {
      if (item.mode === "one_time") oneTimePriceIds.add(item.priceId);
    }
    if (oneTimePriceIds.size === 0) {
      // Nothing stock-tracked to reserve (e.g. a pure subscription cart).
      return { ok: true, reservationIds: [] };
    }

    // Map priceId → { productId, stockCount } via Stripe (product expanded).
    const productByPrice = new Map<
      string,
      { productId: string; stockCount: number | null }
    >();
    await Promise.all(
      [...oneTimePriceIds].map(async (priceId) => {
        const price = await stripe.prices.retrieve(
          priceId,
          { expand: ["product"] },
          requestOptions,
        );
        const product = price.product;
        if (!product || typeof product === "string" || product.deleted) {
          productByPrice.set(priceId, { productId: "", stockCount: null });
          return;
        }
        const meta = (product.metadata ?? {}) as Record<
          string,
          string | undefined
        >;
        productByPrice.set(priceId, {
          productId: product.id,
          stockCount: parseStockCount(meta.stock_count),
        });
      }),
    );

    // Fold per-line quantities into per-product totals, keeping only
    // stock-tracked products (non-null stock_count).
    for (const item of items) {
      if (item.mode !== "one_time") continue;
      const resolved = productByPrice.get(item.priceId);
      if (!resolved || !resolved.productId) continue;
      if (resolved.stockCount === null) continue; // untracked = unlimited
      const existing = qtyByProduct.get(resolved.productId);
      if (existing) {
        existing.qty += item.quantity;
      } else {
        qtyByProduct.set(resolved.productId, {
          qty: item.quantity,
          stockCount: resolved.stockCount,
        });
      }
    }

    if (qtyByProduct.size === 0) {
      // Every line was untracked / unlimited — nothing to reserve.
      return { ok: true, reservationIds: [] };
    }

    const supabase = getOrgScopedClient(orgId);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const reservationIds: string[] = [];

    for (const [productId, { qty, stockCount }] of qtyByProduct) {
      const { data, error } = await supabase
        .raw()
        .schema("resupply")
        .rpc("reserve_inventory", {
          p_org_id: orgId,
          p_sku: productId,
          p_qty: qty,
          p_available: stockCount,
          p_expires_at: expiresAt,
        });
      if (error) throw error;

      // The RPC returns the new reservation uuid, or NULL when granting the
      // hold would oversell. A NULL result is a CLEAN out-of-stock verdict,
      // NOT an error — release what we hold so far and report it.
      const reservationId = typeof data === "string" ? data : null;
      if (!reservationId) {
        if (reservationIds.length > 0) {
          await releaseReservationIds(orgId, reservationIds, log);
        }
        return { ok: false, oversoldProductId: productId };
      }
      reservationIds.push(reservationId);
    }

    return { ok: true, reservationIds };
  } catch (err) {
    // FAIL OPEN. A reservation error must never block a sale.
    log?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      "inventory reservation failed (fail-open; checkout proceeds unguarded)",
    );
    return { ok: true, reservationIds: [] };
  }
}

/**
 * Stamp the created Checkout session id onto a set of reservation rows so the
 * webhook (which only knows the session id) can later consume/release them.
 * Best-effort: a failure here just means the holds expire via TTL instead of
 * being consumed/released precisely — never throws into the checkout path.
 */
export async function attachSessionToReservations(
  orgId: string,
  reservationIds: string[],
  sessionId: string,
  log?: ReservationLogger,
): Promise<void> {
  if (reservationIds.length === 0) return;
  try {
    const supabase = getOrgScopedClient(orgId);
    const { error } = await supabase
      .from("inventory_reservations")
      .update({ checkout_session_id: sessionId })
      .in("id", reservationIds);
    if (error) throw error;
  } catch (err) {
    log?.warn?.(
      {
        sessionId,
        count: reservationIds.length,
        err: err instanceof Error ? err.message : String(err),
      },
      "inventory reservation session-attach failed (non-fatal — holds expire via TTL)",
    );
  }
}

/**
 * Consume (active → consumed) every active hold for a paid session. Called
 * from the checkout.session.completed / async_payment_succeeded webhook.
 * Best-effort — the parent order is already paid; a missed consume just
 * leaves the hold to expire harmlessly via TTL.
 */
export async function consumeReservationsForSession(
  orgId: string,
  sessionId: string,
  log?: ReservationLogger,
): Promise<void> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { error } = await supabase
      .from("inventory_reservations")
      .update({ status: "consumed", consumed_at: new Date().toISOString() })
      .eq("checkout_session_id", sessionId)
      .eq("status", "active");
    if (error) throw error;
  } catch (err) {
    log?.warn?.(
      {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      "inventory reservation consume failed (non-fatal — hold expires via TTL)",
    );
  }
}

/**
 * Release (active → released) every active hold for a session. Called from
 * the checkout.session.expired / async_payment_failed webhook, and from the
 * checkout route when session creation throws after holds were taken. Frees
 * the reserved stock immediately. Best-effort — never throws.
 */
export async function releaseReservationsForSession(
  orgId: string,
  sessionId: string,
  log?: ReservationLogger,
): Promise<void> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { error } = await supabase
      .from("inventory_reservations")
      .update({ status: "released" })
      .eq("checkout_session_id", sessionId)
      .eq("status", "active");
    if (error) throw error;
  } catch (err) {
    log?.warn?.(
      {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      "inventory reservation release failed (non-fatal — hold expires via TTL)",
    );
  }
}

/**
 * Release a set of holds by id. Used when session creation fails after the
 * holds were taken but BEFORE a session id existed to attach (so there's
 * nothing for releaseReservationsForSession to match on). Best-effort.
 */
export async function releaseReservationIds(
  orgId: string,
  reservationIds: string[],
  log?: ReservationLogger,
): Promise<void> {
  if (reservationIds.length === 0) return;
  try {
    const supabase = getOrgScopedClient(orgId);
    const { error } = await supabase
      .from("inventory_reservations")
      .update({ status: "released" })
      .in("id", reservationIds)
      .eq("status", "active");
    if (error) throw error;
  } catch (err) {
    log?.warn?.(
      {
        count: reservationIds.length,
        err: err instanceof Error ? err.message : String(err),
      },
      "inventory reservation release-by-id failed (non-fatal — holds expire via TTL)",
    );
  }
}

/**
 * Sweep: expire (active → expired) every active hold whose TTL has passed for
 * one tenant. Returns the number of rows expired (0 when none / on error).
 * Driven by the inventory-reservation-sweep cron. The `expires_at > now()`
 * filter in reserve_inventory already makes a stale hold not count toward
 * availability, so this sweep is housekeeping (keeps the active partial index
 * small + the ledger truthful), not a correctness dependency.
 */
export async function expireStaleReservations(
  orgId: string,
  log?: ReservationLogger,
): Promise<number> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("inventory_reservations")
      .update({ status: "expired" })
      .eq("status", "active")
      .lt("expires_at", new Date().toISOString())
      .select("id");
    if (error) throw error;
    return data?.length ?? 0;
  } catch (err) {
    log?.warn?.(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "inventory reservation expire-sweep failed for tenant (non-fatal)",
    );
    return 0;
  }
}

/**
 * Sum the still-live active holds per sku (Stripe product id) for a tenant, so
 * the storefront catalog can show stock NET of in-flight reservations instead
 * of the raw point-in-time `stock_count`. Read-only and **fail-open**: any
 * error returns an empty map and the caller falls back to raw stock — the
 * catalog must never break (or hide products) because the ledger hiccuped.
 * Mirrors the `reserve_inventory` availability filter (`status='active'` AND
 * `expires_at > now()`) so the display matches what a checkout would grant.
 */
export async function getActiveReservedBySku(
  orgId: string,
  skus: string[],
  log?: ReservationLogger,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!orgId || !orgId.trim() || skus.length === 0) return out;
  try {
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("inventory_reservations")
      .select("sku, quantity")
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .in("sku", skus);
    if (error) throw error;
    for (const row of data ?? []) {
      out.set(row.sku, (out.get(row.sku) ?? 0) + row.quantity);
    }
  } catch (err) {
    log?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      "inventory reserved-by-sku read failed (non-fatal — catalog shows raw stock)",
    );
  }
  return out;
}
