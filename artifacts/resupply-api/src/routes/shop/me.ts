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
  getOrgScopedClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { ensureShopCustomerRow } from "../../lib/shop-customer/record";
import { resolvePatientIdForCustomer } from "../../lib/shop-customer/resolve-patient";
import { readCustomerProfile } from "../../lib/customer-profile";
import {
  attachSignedIn,
  requireSignedIn,
} from "../../middlewares/requireSignedIn";

type ShopCustomersUpdate =
  Database["resupply"]["Tables"]["shop_customers"]["Update"];

const router: IRouter = Router();

const RECENT_ORDERS_LIMIT = 5;

type RecentOrderSummary = {
  id: string;
  sessionId: string;
  status: string;
  amountTotalCents: number | null;
  currency: string | null;
  createdAt: string;
};

function describeFulfillmentStatus(row: {
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
}): string {
  if (row.delivered_at) return "delivered";
  if (row.shipped_at) return "shipped";
  if (row.status === "cancelled" || row.status === "canceled") {
    return "cancelled";
  }
  return "with_warehouse";
}

router.get("/shop/me", attachSignedIn, async (req, res) => {
  if (!req.userCustomerId) {
    res.json({ signedIn: false });
    return;
  }

  // Pull the email + display name from the request — populated by
  // requireSignedIn / attachSignedIn from auth.users. Helper degrades
  // to null on lookup failure rather than blowing up /shop/me.
  const { email, displayName } = await readCustomerProfile(req);

  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }

  const row = await ensureShopCustomerRow({
    orgId,
    customerId: req.userCustomerId,
    email,
    displayName,
  });

  // Recent orders summary (last 5). Insurance fulfillments take precedence
  // when the caller's email resolves to exactly one patient chart; legacy
  // cash-pay shop_orders fill in when present. No price/line items here.
  const supabase = getOrgScopedClient(orgId);
  const patientId = await resolvePatientIdForCustomer(
    supabase,
    req.userCustomerId,
  );
  const [recentShopRes, recentFulfillmentRes] = await Promise.all([
    supabase
      .from("shop_orders")
      .select(
        "id, stripe_session_id, status, amount_total_cents, currency, created_at",
      )
      .eq("customer_id", req.userCustomerId)
      .order("created_at", { ascending: false })
      .limit(RECENT_ORDERS_LIMIT),
    patientId
      ? supabase
          .from("fulfillments")
          .select("id, status, created_at, shipped_at, delivered_at")
          .eq("patient_id", patientId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(RECENT_ORDERS_LIMIT)
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (recentShopRes.error) throw recentShopRes.error;
  if (recentFulfillmentRes.error) throw recentFulfillmentRes.error;

  const shopRecent: RecentOrderSummary[] = (
    (recentShopRes.data ?? []) as Array<
      Database["resupply"]["Tables"]["shop_orders"]["Row"]
    >
  ).map((r) => ({
    id: r.id,
    sessionId: r.stripe_session_id,
    status: r.status,
    amountTotalCents: r.amount_total_cents,
    currency: r.currency,
    createdAt: r.created_at,
  }));

  const fulfillmentRecent: RecentOrderSummary[] = (
    (recentFulfillmentRes.data ?? []) as Array<{
      id: string;
      status: string;
      created_at: string;
      shipped_at: string | null;
      delivered_at: string | null;
    }>
  ).map((r) => ({
    id: r.id,
    sessionId: "",
    status: describeFulfillmentStatus(r),
    amountTotalCents: null,
    currency: null,
    createdAt: r.created_at,
  }));

  const recentOrders = [...shopRecent, ...fulfillmentRecent]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECENT_ORDERS_LIMIT);

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
    // Patient cash-pay / card-on-file is retired. Keep the field so
    // older SPA builds don't break, but never surface a saved card.
    savedCard: null,
    recentOrders,
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

  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }

  // Make sure the row exists (first-time PUT before any GET).
  await ensureShopCustomerRow({
    orgId,
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

  const supabase = getOrgScopedClient(orgId);
  const { data: row, error } = await supabase
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
