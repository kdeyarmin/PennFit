// /admin/followups — cross-customer daily queue of open follow-ups
// for the CSR team (Phase 18).
//
// Phase 17 surfaced followups inside the customer-360 page (per-
// customer view). This endpoint flips that around — "what does the
// team owe TODAY across all customers?" — so a CSR opening admin
// can land on the queue rather than having to click into each
// customer to find their own commitments.
//
// Returns open (completed_at IS NULL) followups joined with
// shop_customers for the display name + email crumb. Limited to
// 200 rows; the open queue should never realistically grow past
// a few dozen in steady-state.
//
// Order: due_at ASC — most overdue first. The UI buckets into
// "overdue / today / upcoming" client-side using just the timestamps.
//
// PHI posture: same as the per-customer endpoint. The body is
// returned so the panel can render it; logs record only counts.

import { asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";

import {
  getDbPool,
  shopCustomerFollowups,
  shopCustomers,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/admin/followups", requireAdmin, async (req, res) => {
  const db = drizzle(getDbPool());

  const rows = await db
    .select({
      id: shopCustomerFollowups.id,
      customerId: shopCustomerFollowups.customerId,
      body: shopCustomerFollowups.body,
      dueAt: shopCustomerFollowups.dueAt,
      createdByEmail: shopCustomerFollowups.createdByEmail,
      createdAt: shopCustomerFollowups.createdAt,
      customerDisplayName: shopCustomers.displayName,
      customerEmail: shopCustomers.emailLower,
    })
    .from(shopCustomerFollowups)
    .innerJoin(
      shopCustomers,
      eq(shopCustomers.customerId, shopCustomerFollowups.customerId),
    )
    .where(isNull(shopCustomerFollowups.completedAt))
    .orderBy(asc(shopCustomerFollowups.dueAt))
    .limit(200);

  req.log?.info(
    {
      count: rows.length,
      adminEmail: req.adminEmail,
    },
    "admin.followups.list",
  );

  res.json({
    followups: rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerDisplayName: r.customerDisplayName,
      customerEmail: r.customerEmail,
      body: r.body,
      dueAt: r.dueAt.toISOString(),
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

export default router;
