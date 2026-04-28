// GET /shop/me/orders — paginated order history for the signed-in
// shopper. Latest first.
//
// Returns a thin summary suitable for the account page list. Detailed
// "what was in the order" still goes through GET /shop/orders/:id
// (which expands line items via Stripe). We deliberately don't fan
// out a Stripe API call per row here — a 50-row history page would
// spend 50 Stripe round-trips on data the user usually scrolls past.

import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDbPool, shopOrders } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const querySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.min(50, Math.max(1, parseInt(v, 10))) : 20)),
  status: z
    .enum(["paid", "pending", "expired", "failed", "refunded"])
    .optional(),
});

router.get("/shop/me/orders", requireSignedIn, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { limit, status } = parsed.data;

  const db = drizzle(getDbPool());

  const where = status
    ? and(
        eq(shopOrders.clerkUserId, req.userClerkId!),
        eq(shopOrders.status, status),
      )
    : eq(shopOrders.clerkUserId, req.userClerkId!);

  const rows = await db
    .select({
      id: shopOrders.id,
      stripeSessionId: shopOrders.stripeSessionId,
      status: shopOrders.status,
      amountTotalCents: shopOrders.amountTotalCents,
      currency: shopOrders.currency,
      createdAt: shopOrders.createdAt,
      paidAt: shopOrders.paidAt,
    })
    .from(shopOrders)
    .where(where)
    .orderBy(desc(shopOrders.createdAt))
    .limit(limit);

  res.json({
    orders: rows.map((r) => ({
      id: r.id,
      sessionId: r.stripeSessionId,
      status: r.status,
      amountTotalCents: r.amountTotalCents,
      currency: r.currency,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
    })),
  });
});

export default router;
