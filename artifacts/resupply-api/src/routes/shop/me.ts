// /shop/me — patient-facing account endpoints.
//
//   GET  /shop/me      — always 200; returns { signedIn, profile? }.
//                        Frontend uses the response to decide whether
//                        to render the account UI or a "sign in to
//                        save your info" prompt.
//   PUT  /shop/me      — update display name + shipping address.
//                        Auth required.
//
// Why GET never 401s: the cart page always calls /shop/me to decide
// whether to show the "Express checkout" button. A 401 there would
// have to be silently swallowed everywhere it's called from. A
// `{signedIn: false}` envelope is honest and lets the frontend
// branch deliberately.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { ensureShopCustomerRow } from "../../lib/stripe/customer";
import { readCustomerProfile } from "../../lib/customer-profile";
import {
  attachSignedIn,
  requireSignedIn,
} from "../../middlewares/requireSignedIn";

type ShopCustomersUpdate =
  Database["resupply"]["Tables"]["shop_customers"]["Update"];

const router: IRouter = Router();

const RECENT_ORDERS_LIMIT = 5;

router.get("/shop/me", attachSignedIn, async (req, res) => {
  if (!req.userCustomerId) {
    res.json({ signedIn: false });
    return;
  }

  // Pull the email + display name from the request — populated by
  // requireSignedIn / attachSignedIn from auth.users. Helper degrades
  // to null on lookup failure rather than blowing up /shop/me.
  const { email, displayName } = await readCustomerProfile(req);

  const row = await ensureShopCustomerRow({
    customerId: req.userCustomerId,
    email,
    displayName,
  });

  // Recent orders summary (last 5). We DON'T expose price/line items
  // here — that's behind /shop/me/orders so the account header stays
  // light. Just enough to render "3 past orders, latest Apr 22".
  const supabase = getSupabaseServiceRoleClient();
  const { data: recent, error: recentErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select(
      "id, stripe_session_id, status, amount_total_cents, currency, created_at",
    )
    .eq("customer_id", req.userCustomerId)
    .order("created_at", { ascending: false })
    .limit(RECENT_ORDERS_LIMIT);
  if (recentErr) throw recentErr;

  res.json({
    signedIn: true,
    profile: {
      customerId: row.customer_id,
      email: row.email_lower,
      displayName: row.display_name,
      shippingAddress: row.shipping_address_json ?? null,
      // Clinical info added in 0032 — both nullable, both freshly
      // null on a brand-new account. The dedicated
      // GET /shop/me/clinical-info endpoint returns the same shape
      // alone for the account-page sub-section, but surfacing here
      // means callers that already fetch /shop/me (e.g. the cart
      // for a future "ship to my CPAP" handoff) don't need a
      // second round-trip to read the device.
      cpapDevice: row.cpap_device_json ?? null,
      physicianInfo: row.physician_info_json ?? null,
    },
    savedCard: row.default_payment_method_id
      ? {
          brand: row.default_payment_method_brand,
          last4: row.default_payment_method_last4,
          expMonth: row.default_payment_method_exp_month,
          expYear: row.default_payment_method_exp_year,
        }
      : null,
    recentOrders: (recent ?? []).map((r) => ({
      id: r.id,
      sessionId: r.stripe_session_id,
      status: r.status,
      amountTotalCents: r.amount_total_cents,
      currency: r.currency,
      createdAt: r.created_at,
    })),
  });
});

const updateBody = z
  .object({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    shippingAddress: z
      .object({
        line1: z.string().trim().min(1).max(120),
        line2: z.string().trim().max(120).nullable().optional(),
        city: z.string().trim().min(1).max(80),
        state: z.string().trim().length(2).toUpperCase(),
        postalCode: z
          .string()
          .trim()
          .regex(/^\d{5}(-\d{4})?$/, "ZIP must be 5 or 9 digits"),
        country: z.literal("US").default("US"),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

router.put("/shop/me", requireSignedIn, async (req, res) => {
  const parsed = updateBody.safeParse(req.body);
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
  const { displayName, shippingAddress } = parsed.data;

  // Make sure the row exists (first-time PUT before any GET).
  await ensureShopCustomerRow({
    customerId: req.userCustomerId!,
    email: null,
  });

  const updates: ShopCustomersUpdate = {
    updated_at: new Date().toISOString(),
  };
  if (displayName !== undefined) updates.display_name = displayName;
  if (shippingAddress !== undefined) {
    updates.shipping_address_json = (shippingAddress
      ? { ...shippingAddress, line2: shippingAddress.line2 ?? null }
      : null) as unknown as Json;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update(updates)
    .eq("customer_id", req.userCustomerId!)
    .select("customer_id, email_lower, display_name, shipping_address_json")
    .single();
  if (error) {
    // Log the PostgREST detail server-side; the customer gets only the
    // stable error code (June-10 audit, P3 — a raw DB error message
    // can leak schema/table names to an end user).
    logger.error(
      { event: "shop_me_profile_update_failed", err: error },
      "shop/me: profile update failed",
    );
    res.status(500).json({ error: "update_failed" });
    return;
  }
  if (!row) {
    res.status(500).json({ error: "update_failed" });
    return;
  }

  res.json({
    profile: {
      customerId: row.customer_id,
      email: row.email_lower,
      displayName: row.display_name,
      shippingAddress: row.shipping_address_json ?? null,
    },
  });
});

export default router;
