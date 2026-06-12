// POST /admin/shop/counter-orders — CSR "Front Desk" walk-in ordering.
//
// Lets a customer-service rep ring up an order for a walk-in customer at
// the DME counter, in real time, WITHOUT the storefront's Stripe Hosted
// Checkout flow. Two payment lanes (the only two the counter handles):
//
//   * cash      — money collected at the counter. The order is recorded
//                 as `status='paid'`, `paid_at=now()`. Default
//                 fulfillment is `pickup`, so the CSR can immediately
//                 mark it picked up (POST /admin/shop/orders/:id/picked-up)
//                 and hand the product over.
//   * insurance — the supplies are still dispensed now (handed over /
//                 shipped) — fulfillment is independent of payment. But
//                 `paid` means money RECEIVED, and an insurance order is
//                 not paid until the payer adjudicates and pays the
//                 claim, so it is recorded as `status='pending'`. The
//                 existing claims pipeline (on the patient record) files
//                 and works the claim — we deliberately do NOT reimplement
//                 claim generation here.
//
// Catalog + pricing trust model:
//   The client sends only { priceId, quantity } per line. We NEVER trust
//   client-sent amounts. Every line is validated against the live Stripe
//   catalog with the SAME guard the storefront checkout uses
//   (`validateCartItems`, all lines in one_time mode), then re-priced
//   server-side from Stripe so `amount_total_cents` reflects the
//   storefront-approved price. Counter orders are one-time only — there
//   is no in-person subscription lane.
//
// Stripe dependency:
//   We need Stripe to resolve the catalog + prices even though no charge
//   is created here, so the endpoint 503s (`stripe_not_configured`) in a
//   preview env without Stripe — mirroring the refund endpoint's posture.
//
// shop_orders shape note:
//   `stripe_session_id` is NOT NULL + UNIQUE. Counter orders never touch
//   Stripe Checkout, so we mint a synthetic `counter-<uuid>` id that
//   satisfies the constraint and namespaces these rows. The Stripe
//   webhook keys on real `cs_*` session ids and will never collide.
//
// PHI / logging:
//   The audit row records ids + counts + the order's commercial shape
//   (payment method, fulfillment, total) — never the cart body, never
//   the customer's name/email. Order request bodies are PHI-adjacent and
//   must not be logged (hard rule).

import { randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
  type SavedShippingAddress,
} from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { validateCartItems } from "../../lib/stripe/validate-cart";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import { getActivePickupLocationById } from "../../lib/pickup/locations";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { withIdempotency } from "../../middlewares/idempotency";
import { requirePermission } from "../../middlewares/requireAdmin";

type ShopOrderInsert = Database["resupply"]["Tables"]["shop_orders"]["Insert"];
type ShopOrderItemInsert =
  Database["resupply"]["Tables"]["shop_order_items"]["Insert"];

const router: IRouter = Router();

// Mirror the storefront checkout address shape (US-only) so the same UI
// form + validator can feed this endpoint for shipped counter orders.
const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z
      .union([z.string().trim().max(200), z.null()])
      .optional()
      .transform((v) => (v == null || v === "" ? null : v)),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(2).max(2),
    postalCode: z.string().trim().min(3).max(20),
    country: z.literal("US"),
  })
  .strict();

const bodySchema = z
  .object({
    // Optional clinical-patient link. Stored indirectly via the patient's
    // email (customerEmail) so the existing patient↔shop_customer
    // email-lower binding resolves the order onto the patient record.
    patientId: z.string().uuid().nullish(),
    // Optional existing storefront customer (shop_customers.customer_id).
    customerId: z.string().trim().min(1).max(100).nullish(),
    // Email captured at the counter (the walk-in's, or the linked
    // patient's). Normalised to lowercase to match email-lower joins.
    customerEmail: z
      .string()
      .trim()
      .email()
      .max(254)
      .nullish()
      .transform((v) => (v == null || v === "" ? null : v.toLowerCase())),
    items: z
      .array(
        z
          .object({
            priceId: z
              .string()
              .min(1)
              .max(100)
              .regex(/^price_/, "priceId must start with price_"),
            quantity: z.number().int().min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    paymentMethod: z.enum(["cash", "insurance"]),
    fulfillmentMethod: z.enum(["pickup", "ship"]).default("pickup"),
    pickupLocationId: z.string().uuid().nullish(),
    shippingAddress: addressSchema.nullish(),
  })
  .strict();

router.post(
  "/admin/shop/counter-orders",
  adminWriteRateLimiter,
  requirePermission("orders.create"),
  withIdempotency("POST /admin/shop/counter-orders"),
  async (req, res) => {
    // Control Center gate — admins can disable counter ordering without
    // a deploy. Existing orders and the rest of the app are unaffected.
    if (!(await isFeatureEnabled("frontdesk.counter_orders"))) {
      res.status(503).json({
        error: "counter_orders_disabled",
        message:
          "Front Desk counter ordering is turned off. Enable it in the Control Center to ring up walk-in orders.",
      });
      return;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const body = parsed.data;

    // We need Stripe to resolve the approved catalog price for each line.
    // No charge is created — but without the catalog we can't safely
    // price the order, so refuse cleanly in a Stripe-less preview env.
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const stripe = getStripeClient(config);
    const supabase = getSupabaseServiceRoleClient();

    // Collapse duplicate-priceId lines (sum quantities). The
    // shop_order_items unique index is
    // (stripe_session_id, product_id, price_id), so two lines with the
    // same price would 500 the items insert AFTER the order row is
    // already written — orphaning an order with a total but no lines
    // (there's no surrounding transaction). Deduping up front means the
    // cart guard, the server-side total, and the insert all see exactly
    // one row per price.
    const items = Array.from(
      body.items
        .reduce(
          (m, it) => m.set(it.priceId, (m.get(it.priceId) ?? 0) + it.quantity),
          new Map<string, number>(),
        )
        .entries(),
    ).map(([priceId, quantity]) => ({ priceId, quantity }));

    // Resolve the order's customer binding. shop_orders attaches to a
    // patient via email-lower, so when the CSR selects an existing patient
    // (the UI sends only patientId, never PHI email) we look the email up
    // server-side rather than surfacing it in the search results. An
    // explicit customerEmail / customerId from the caller still wins. A
    // bad patientId 404s before we touch Stripe or write anything.
    let customerEmail = body.customerEmail ?? null;
    if (body.patientId) {
      const { data: patientRow, error: patErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("email")
        .eq("id", body.patientId)
        .maybeSingle();
      if (patErr) throw patErr;
      if (!patientRow) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
      if (!customerEmail && !body.customerId && patientRow.email) {
        customerEmail = patientRow.email;
      }
    }
    // order. Pickup needs an active location; ship needs an address.
    const isPickup = body.fulfillmentMethod === "pickup";
    let pickupLocationId: string | null = null;
    let shippingAddress: SavedShippingAddress | null = null;
    if (isPickup) {
      const location = body.pickupLocationId
        ? await getActivePickupLocationById(body.pickupLocationId)
        : null;
      if (!location) {
        res.status(400).json({
          error: "pickup_location_invalid",
          message: "Choose a valid pickup location for this counter order.",
        });
        return;
      }
      pickupLocationId = location.id;
    } else {
      if (!body.shippingAddress) {
        res.status(400).json({
          error: "shipping_address_required",
          message: "A shipping address is required for a shipped order.",
        });
        return;
      }
      shippingAddress = {
        line1: body.shippingAddress.line1,
        line2: body.shippingAddress.line2 ?? null,
        city: body.shippingAddress.city,
        state: body.shippingAddress.state.toUpperCase(),
        postalCode: body.shippingAddress.postalCode,
        country: "US",
      };
    }

    // Catalog guard — identical fence the storefront applies. Counter
    // lines are always one_time (no in-person subscription lane).
    const cartItems = items.map((it) => ({
      priceId: it.priceId,
      quantity: it.quantity,
      mode: "one_time" as const,
    }));
    const cartValidation = await validateCartItems(stripe, cartItems);
    if (!cartValidation.ok) {
      res.status(400).json({
        error: "cart_invalid",
        issues: cartValidation.errors.map((e) => ({
          priceId: e.priceId,
          reason: e.reason,
          message: e.message,
        })),
      });
      return;
    }

    // Re-price server-side from Stripe. validateCartItems already proved
    // each priceId is the storefront-approved one_time price for an
    // active catalog product, so a retrieve here yields the trustworthy
    // unit_amount + owning product id. One retrieve per unique price
    // (cart bounded to 20).
    const uniquePriceIds = items.map((i) => i.priceId);
    const priceById = new Map<
      string,
      { unitAmountCents: number; currency: string; productId: string }
    >();
    try {
      await Promise.all(
        uniquePriceIds.map(async (priceId) => {
          const price = await stripe.prices.retrieve(priceId, {
            expand: ["product"],
          });
          const productId =
            typeof price.product === "string"
              ? price.product
              : price.product?.id;
          if (price.unit_amount == null || !productId) {
            throw new Error(`price ${priceId} missing unit_amount/product`);
          }
          priceById.set(priceId, {
            unitAmountCents: price.unit_amount,
            currency: price.currency,
            productId,
          });
        }),
      );
    } catch (err) {
      req.log?.warn(
        { ...stripeErrLogFields(err) },
        "counter-orders: price retrieve failed",
      );
      res.status(502).json({ error: "stripe_price_lookup_failed" });
      return;
    }

    // Compute the order total server-side and assemble the line rows.
    let amountTotalCents = 0;
    let currency: string | null = null;
    for (const it of items) {
      const priced = priceById.get(it.priceId)!;
      amountTotalCents += priced.unitAmountCents * it.quantity;
      currency = currency ?? priced.currency;
    }

    const nowIso = new Date().toISOString();
    const isCash = body.paymentMethod === "cash";
    // Synthetic, namespaced, collision-free session id (see header).
    const sessionId = `counter-${randomUUID()}`;

    const orderInsert: ShopOrderInsert = {
      stripe_session_id: sessionId,
      status: isCash ? "paid" : "pending",
      source: "counter",
      payment_method: body.paymentMethod,
      counter_csr_email: req.adminEmail ?? null,
      amount_total_cents: amountTotalCents,
      currency,
      fulfillment_method: body.fulfillmentMethod,
      // Pickup goods are physically at the counter the instant the order
      // is rung up, so the order is "ready for pickup" immediately — stamp
      // it on insert. This lets the Front Desk hand the item over right
      // away via the existing POST /admin/shop/orders/:id/picked-up
      // endpoint (which requires ready_for_pickup_at but, correctly, does
      // NOT require status='paid'). Fulfillment is independent of payment:
      // the patient walks out with the supplies in both lanes. No
      // ready-for-pickup email is sent (the patient is standing here).
      ...(pickupLocationId
        ? {
            pickup_location_id: pickupLocationId,
            ready_for_pickup_at: nowIso,
          }
        : {}),
      ...(shippingAddress
        ? { shipping_address_json: shippingAddress as unknown as Json }
        : {}),
      ...(body.customerId ? { customer_id: body.customerId } : {}),
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      // `paid` means money received. Cash is collected at the counter, so
      // it's paid now. An insurance order is NOT paid until the payer
      // adjudicates and pays the claim — it stays `pending` while the
      // supplies are still dispensed above. paid_at is only stamped for
      // cash.
      ...(isCash ? { paid_at: nowIso } : {}),
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { data: orderRow, error: orderErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .insert(orderInsert)
      .select("id")
      .single();
    if (orderErr) throw orderErr;
    const orderId = orderRow.id;

    // Line items. paid_at is NOT NULL on shop_order_items, so we stamp
    // now() in both lanes — it records when the line was captured at the
    // counter. The order's own status/paid_at carry the payment state.
    const itemRows: ShopOrderItemInsert[] = items.map((it) => {
      const priced = priceById.get(it.priceId)!;
      return {
        order_id: orderId,
        stripe_session_id: sessionId,
        ...(body.customerId ? { customer_id: body.customerId } : {}),
        product_id: priced.productId,
        price_id: it.priceId,
        quantity: it.quantity,
        unit_amount_cents: priced.unitAmountCents,
        currency: priced.currency,
        paid_at: nowIso,
      };
    });
    const { error: itemsErr } = await supabase
      .schema("resupply")
      .from("shop_order_items")
      .insert(itemRows);
    if (itemsErr) throw itemsErr;

    req.log?.info?.(
      {
        orderId,
        adminEmail: req.adminEmail,
        paymentMethod: body.paymentMethod,
        fulfillmentMethod: body.fulfillmentMethod,
        itemCount: itemRows.length,
      },
      "admin/shop/counter-orders: counter order created",
    );

    // Audit — ids + commercial shape only, never the cart body or PHI.
    try {
      await logAudit({
        action: "shop_order.counter.created",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "shop_orders",
        targetId: orderId,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: {
          order_id: orderId,
          item_count: itemRows.length,
          amount_total_cents: amountTotalCents,
          payment_method: body.paymentMethod,
          fulfillment_method: body.fulfillmentMethod,
          status: orderInsert.status,
          linked_patient: body.patientId != null,
        },
      });
    } catch (err) {
      req.log?.warn?.(
        { err, orderId },
        "shop_order.counter.created audit write failed (non-fatal)",
      );
    }

    res.status(201).json({
      order: {
        id: orderId,
        status: orderInsert.status,
        source: "counter",
        paymentMethod: body.paymentMethod,
        fulfillmentMethod: body.fulfillmentMethod,
        pickupLocationId,
        amountTotalCents,
        currency,
        itemCount: itemRows.length,
      },
    });
  },
);

export default router;
