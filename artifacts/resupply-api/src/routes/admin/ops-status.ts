// /admin/ops-status — operations center status feed.
//
// One round-trip that returns the operator-facing health signals the
// /admin/operations page renders:
//   * vendor connectivity flags (sendgrid, twilio, stripe)
//   * dispatcher-eligible row counts (so admins know whether running
//     a dispatcher will actually do anything)
//   * team counts (active admins, active agents, pending invites)
//
// No vendor round-trips here — every check is a pure env-var read or
// a local SQL count, so the page loads in <100ms even when SendGrid
// is having a bad day.

import { Router, type IRouter } from "express";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  adminUsers,
  getDbPool,
  shopAbandonedCarts,
  shopOrders,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const NUDGE_WAIT_MS = 24 * 60 * 60 * 1000;
const REVIEW_REQUEST_AGE_DAYS = 14;

router.get("/admin/ops-status", requireAdmin, async (_req, res) => {
  const db = drizzle(getDbPool());

  // Vendor flags. We deliberately don't ping the vendor APIs —
  // a missing key reliably means "feature disabled" and pinging
  // would slow the page down for negligible value. Boolean
  // presence is enough.
  const vendors = {
    sendgrid: Boolean(
      process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL,
    ),
    twilioVoice: Boolean(
      process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN,
    ),
    twilioSms: Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_MESSAGING_SERVICE_SID,
    ),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    objectStorage: Boolean(process.env.PRIVATE_OBJECT_DIR),
  };

  const cutoff24h = new Date(Date.now() - NUDGE_WAIT_MS);

  // Dispatcher-eligible counts. Mirrors the dispatcher WHERE clauses
  // exactly so "Run now" buttons can be honest about what they'll
  // process.
  const [abandonedCartEligible] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopAbandonedCarts)
    .where(
      and(
        lte(shopAbandonedCarts.updatedAt, cutoff24h),
        isNull(shopAbandonedCarts.remindedAt),
        isNull(shopAbandonedCarts.recoveredAt),
        isNull(shopAbandonedCarts.clearedAt),
        sql`jsonb_array_length(${shopAbandonedCarts.items}) > 0`,
      ),
    );

  const [reviewRequestEligible] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopOrders)
    .where(
      and(
        eq(shopOrders.status, "paid"),
        sql`${shopOrders.paidAt} <= now() - (${REVIEW_REQUEST_AGE_DAYS} || ' days')::interval`,
        isNull(shopOrders.reviewRequestSentAt),
        sql`${shopOrders.customerId} IS NOT NULL`,
      ),
    );

  // Team counts.
  const [adminCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminUsers)
    .where(and(eq(adminUsers.status, "active"), eq(adminUsers.role, "admin")));
  const [agentCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminUsers)
    .where(and(eq(adminUsers.status, "active"), eq(adminUsers.role, "agent")));
  const [pendingCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminUsers)
    .where(eq(adminUsers.status, "pending"));

  res.json({
    vendors,
    dispatchers: {
      abandonedCart: { eligibleNow: abandonedCartEligible?.count ?? 0 },
      reviewRequest: { eligibleNow: reviewRequestEligible?.count ?? 0 },
    },
    team: {
      activeAdmins: adminCount?.count ?? 0,
      activeAgents: agentCount?.count ?? 0,
      pendingInvites: pendingCount?.count ?? 0,
    },
    serverTime: new Date().toISOString(),
  });
});

export default router;
