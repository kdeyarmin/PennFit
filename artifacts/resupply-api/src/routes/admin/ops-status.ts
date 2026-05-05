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
  patientSmartTriggerEvents,
  physicianFaxOutreach,
  prescriptions,
  shopAbandonedCarts,
  shopOrders,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { RENEWAL_WINDOW_DAYS } from "@workspace/resupply-domain";

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
    twilioFax: Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FAX_FROM_NUMBER,
    ),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    objectStorage: Boolean(process.env.PRIVATE_OBJECT_DIR),
  };

  const cutoff24h = new Date(Date.now() - NUDGE_WAIT_MS);

  // All counts run concurrently — independent queries with no ordering
  // dependency between them.
  const [
    [abandonedCartEligible],
    [reviewRequestEligible],
    [rxRenewalEligible],
    [smartTriggerEligible],
    [pendingFaxEligible],
    [adminCount],
    [agentCount],
    [pendingCount],
  ] = await Promise.all([
    // Dispatcher-eligible counts. Mirror each dispatcher's WHERE clause
    // exactly so "Run now" buttons are honest about what they'll process.
    db
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
      ),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(shopOrders)
      .where(
        and(
          eq(shopOrders.status, "paid"),
          sql`${shopOrders.paidAt} <= now() - (${REVIEW_REQUEST_AGE_DAYS} || ' days')::interval`,
          isNull(shopOrders.reviewRequestSentAt),
          sql`${shopOrders.customerId} IS NOT NULL`,
        ),
      ),

    // Phase G.12 — active Rx within the renewal window, not yet nudged.
    // RENEWAL_WINDOW_DAYS is shared with prescription-renewals.ts so the
    // count stays in sync when the window is tuned.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(prescriptions)
      .where(
        and(
          eq(prescriptions.status, "active"),
          isNull(prescriptions.renewalRequestedAt),
          sql`${prescriptions.validUntil} IS NOT NULL`,
          sql`${prescriptions.validUntil}::timestamptz <= now() + (${RENEWAL_WINDOW_DAYS} || ' days')::interval`,
        ),
      ),

    // Phase G.12 — detected-but-unsent smart-trigger events.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(patientSmartTriggerEvents)
      .where(
        and(
          isNull(patientSmartTriggerEvents.sentAt),
          isNull(patientSmartTriggerEvents.dismissedAt),
        ),
      ),

    // Physician fax outreach rows awaiting dispatch (pending or failed
    // with Twilio configured — the retry endpoint can re-fire these).
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(physicianFaxOutreach)
      .where(
        sql`${physicianFaxOutreach.status} IN ('pending', 'failed')`,
      ),

    // Team counts.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminUsers)
      .where(and(eq(adminUsers.status, "active"), eq(adminUsers.role, "admin"))),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminUsers)
      .where(and(eq(adminUsers.status, "active"), eq(adminUsers.role, "agent"))),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminUsers)
      .where(eq(adminUsers.status, "pending")),
  ]);

  res.json({
    vendors,
    dispatchers: {
      abandonedCart: { eligibleNow: abandonedCartEligible?.count ?? 0 },
      reviewRequest: { eligibleNow: reviewRequestEligible?.count ?? 0 },
      rxRenewal: { eligibleNow: rxRenewalEligible?.count ?? 0 },
      smartTrigger: { eligibleNow: smartTriggerEligible?.count ?? 0 },
      pendingFax: { eligibleNow: pendingFaxEligible?.count ?? 0 },
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
