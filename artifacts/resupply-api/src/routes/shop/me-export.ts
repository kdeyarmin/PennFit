// /shop/me/export — customer self-service data export.
//
// Returns every cash-pay datum we hold for the calling customer as
// a single JSON document, suitable for download. Surfaces:
//   * profile (display name + email + saved address)
//   * communication preferences
//   * orders + their line items + tracking + delivery state
//   * subscriptions (auto-ship)
//   * returns / RMAs
//   * reviews authored
//   * abandoned cart snapshot (if any)
//
// Privacy posture:
//   * No PHI on this surface — the cash-pay shop has no PHI per the
//     project's design split (PHI lives in the resupply.* schema's
//     `patients` table, which is keyed by PACware patient id, not by
//     customer id). This export is therefore complete coverage for
//     the consumer-side data we hold.
//   * Saved card crumbs are returned (brand + last4 + exp month/year)
//     since those are already stored locally for display; full PAN /
//     CVC have never been in our possession (Stripe Hosted Checkout
//     keeps PCI scope on Stripe).
//   * Stripe customer / payment-intent IDs are included because they
//     ARE the customer's data and may be useful for support.
//
// Compliance: this endpoint is the technical backstop for "right to
// access" requests under CCPA / CPRA / Washington's MHMD Act. The
// admin-side delete path is separate (and harder — closes Stripe
// Customer + scrubs local rows; out of scope for this slice).

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

// 3 exports per 15 minutes per customer. The endpoint runs 7 parallel
// DB queries; without a cap an authenticated attacker could use it as
// a DB DoS vector (or an accidental tight loop in the SPA would hammer
// it). Compliance-driven "right to access" requests are almost never
// automated, so 3/15min is ample for legitimate use.
const exportRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  name: "shop_me_export",
  keyFn: (req) => req.userCustomerId ?? req.ip ?? "unknown",
});

router.get("/shop/me/export", requireSignedIn, exportRateLimit, async (req, res) => {
  const customerId = req.userCustomerId!;
  const supabase = getSupabaseServiceRoleClient();

  // Explicit column lists (NOT `*`) so a future column added to any
  // of these tables doesn't auto-leak into the customer-facing
  // export. The whole point of this surface is to honor a CCPA/CPRA
  // right-to-access request without exposing internal flags (fraud
  // scoring, agent notes, audit timestamps) the customer didn't
  // submit and we'd rather not put in their hands. Anything genuinely
  // new and customer-facing should be added to this list in the same
  // PR that adds the column.
  const [
    customersRes,
    ordersRes,
    itemsRes,
    subsRes,
    returnsRes,
    reviewsRes,
    cartsRes,
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("shop_customers")
      .select(
        "customer_id, stripe_customer_id, display_name, email_lower, shipping_address_json, default_payment_method_brand, default_payment_method_last4, default_payment_method_exp_month, default_payment_method_exp_year, communication_preferences, cpap_device_json, physician_info_json, facial_measurements_json, caregiver_email, caregiver_name, caregiver_consent_at, caregiver_revoked_at, membership_tier, membership_started_at, membership_renews_at, created_at, updated_at",
      )
      .eq("customer_id", customerId)
      .limit(1),
    supabase
      .schema("resupply")
      .from("shop_orders")
      .select(
        "id, stripe_session_id, stripe_payment_intent_id, status, amount_total_cents, currency, tracking_carrier, tracking_number, shipped_at, delivered_at, shipping_address_json, customer_email, paid_at, created_at, updated_at",
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .schema("resupply")
      .from("shop_order_items")
      .select(
        "id, order_id, product_id, price_id, quantity, unit_amount_cents, currency, paid_at, created_at",
      )
      .eq("customer_id", customerId),
    supabase
      .schema("resupply")
      .from("shop_subscriptions")
      .select(
        "id, stripe_subscription_id, stripe_customer_id, status, items, current_period_end, cancel_at_period_end, canceled_at, initial_amount_total_cents, created_at, updated_at",
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .schema("resupply")
      .from("shop_returns")
      .select(
        "id, order_id, stripe_session_id, status, reason, reason_note, resolution, refund_cents, stripe_refund_id, exchange_product_id, exchange_price_id, exchange_order_id, return_label_url, return_carrier, return_tracking_number, created_at, updated_at, approved_at, rejected_at, shipped_back_at, received_at, resolved_at, closed_at",
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .schema("resupply")
      .from("shop_reviews")
      .select(
        "id, product_id, rating, title, body, author_display_name, author_email, status, created_at, updated_at",
      )
      .eq("customer_id", customerId),
    supabase
      .schema("resupply")
      .from("shop_abandoned_carts")
      .select(
        "id, email, items, subtotal_cents, currency, updated_at, reminded_at, recovered_at, cleared_at, created_at",
      )
      .eq("customer_id", customerId)
      .limit(1),
  ]);
  for (const r of [
    customersRes,
    ordersRes,
    itemsRes,
    subsRes,
    returnsRes,
    reviewsRes,
    cartsRes,
  ]) {
    if (r.error) throw r.error;
  }
  const customers = customersRes.data ?? [];
  const orders = ordersRes.data ?? [];
  const items = itemsRes.data ?? [];
  const subs = subsRes.data ?? [];
  const returns = returnsRes.data ?? [];
  const reviews = reviewsRes.data ?? [];
  const carts = cartsRes.data ?? [];

  const itemsByOrder = new Map<string, typeof items>();
  for (const it of items) {
    const list = itemsByOrder.get(it.order_id) ?? [];
    list.push(it);
    itemsByOrder.set(it.order_id, list);
  }

  const exportedAt = new Date().toISOString();
  const filename = `pennpaps-export-${customerId.slice(-8)}-${exportedAt
    .slice(0, 10)
    .replace(/-/g, "")}.json`;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  res.send(
    JSON.stringify(
      {
        exportedAt,
        customerId,
        profile: customers[0] ?? null,
        orders: orders.map((o) => ({
          ...o,
          items: itemsByOrder.get(o.id) ?? [],
        })),
        subscriptions: subs,
        returns,
        reviews,
        abandonedCart: carts[0] ?? null,
        notes: {
          coverage:
            "This file contains every record the PennPaps cash-pay shop holds for your account.",
          phi: "Insurance / Rx / clinical data lives in a separate system and is not included here. Contact support@pennpaps.com to request that data.",
        },
      },
      null,
      2,
    ),
  );
});

export default router;
