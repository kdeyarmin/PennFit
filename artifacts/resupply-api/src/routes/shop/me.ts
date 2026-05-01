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
import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDbPool, shopOrders, shopCustomers } from "@workspace/resupply-db";

import { ensureShopCustomerRow } from "../../lib/stripe/customer";
import { readCustomerProfile } from "../../lib/customer-profile";
import { attachSignedIn, requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const RECENT_ORDERS_LIMIT = 5;

router.get("/shop/me", attachSignedIn, async (req, res) => {
  if (!req.userClerkId) {
    res.json({ signedIn: false });
    return;
  }

  // Source-aware enrichment. In-house mode: read the email +
  // display name from the request, populated by requireSignedIn /
  // attachSignedIn from auth.users. Clerk mode: fall through to
  // clerkClient.users.getUser. Either way the helper degrades to
  // null on lookup failure rather than blowing up /shop/me.
  const { email, displayName } = await readCustomerProfile(req);

  const row = await ensureShopCustomerRow({
    clerkUserId: req.userClerkId,
    email,
    displayName,
  });

  // Recent orders summary (last 5). We DON'T expose price/line items
  // here — that's behind /shop/me/orders so the account header stays
  // light. Just enough to render "3 past orders, latest Apr 22".
  const db = drizzle(getDbPool());
  const recent = await db
    .select({
      id: shopOrders.id,
      stripeSessionId: shopOrders.stripeSessionId,
      status: shopOrders.status,
      amountTotalCents: shopOrders.amountTotalCents,
      currency: shopOrders.currency,
      createdAt: shopOrders.createdAt,
    })
    .from(shopOrders)
    .where(eq(shopOrders.clerkUserId, req.userClerkId))
    .orderBy(desc(shopOrders.createdAt))
    .limit(RECENT_ORDERS_LIMIT);

  res.json({
    signedIn: true,
    profile: {
      clerkUserId: row.clerkUserId,
      email: row.emailLower,
      displayName: row.displayName,
      shippingAddress: row.shippingAddress ?? null,
    },
    savedCard: row.defaultPaymentMethodId
      ? {
          brand: row.defaultPaymentMethodBrand,
          last4: row.defaultPaymentMethodLast4,
          expMonth: row.defaultPaymentMethodExpMonth,
          expYear: row.defaultPaymentMethodExpYear,
        }
      : null,
    recentOrders: recent.map((r) => ({
      id: r.id,
      sessionId: r.stripeSessionId,
      status: r.status,
      amountTotalCents: r.amountTotalCents,
      currency: r.currency,
      createdAt: r.createdAt.toISOString(),
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
    clerkUserId: req.userClerkId!,
    email: null,
  });

  const updates: Partial<typeof shopCustomers.$inferInsert> & {
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (displayName !== undefined) updates.displayName = displayName;
  if (shippingAddress !== undefined) {
    updates.shippingAddress = shippingAddress
      ? { ...shippingAddress, line2: shippingAddress.line2 ?? null }
      : null;
  }

  const db = drizzle(getDbPool());
  const [row] = await db
    .update(shopCustomers)
    .set(updates)
    .where(eq(shopCustomers.clerkUserId, req.userClerkId!))
    .returning();

  if (!row) {
    res.status(500).json({ error: "update_failed" });
    return;
  }

  res.json({
    profile: {
      clerkUserId: row.clerkUserId,
      email: row.emailLower,
      displayName: row.displayName,
      shippingAddress: row.shippingAddress ?? null,
    },
  });
});

export default router;
