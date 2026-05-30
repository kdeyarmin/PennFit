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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { RENEWAL_WINDOW_DAYS } from "@workspace/resupply-domain";

const router: IRouter = Router();

const NUDGE_WAIT_MS = 24 * 60 * 60 * 1000;
const REVIEW_REQUEST_AGE_DAYS = 14;

router.get("/admin/ops-status", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();

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
      process.env.TWILIO_FAX_FROM_NUMBER &&
      (process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ||
        process.env.RAILWAY_PUBLIC_DOMAIN),
    ),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    objectStorage: Boolean(process.env.SUPABASE_STORAGE_BUCKET_PRIVATE),
  };

  const cutoff24h = new Date(Date.now() - NUDGE_WAIT_MS).toISOString();
  const reviewCutoff = new Date(
    Date.now() - REVIEW_REQUEST_AGE_DAYS * 86400_000,
  ).toISOString();
  const renewalCutoff = new Date(Date.now() + RENEWAL_WINDOW_DAYS * 86400_000)
    .toISOString()
    .slice(0, 10); // valid_until is a `date` column

  // All counts run concurrently — independent queries with no ordering
  // dependency between them.
  //
  // Note: the original `jsonb_array_length(items) > 0` predicate on
  // shop_abandoned_carts is replaced with `.neq('items', '[]')`. PostgREST
  // doesn't expose jsonb_array_length, but a stored empty cart is always
  // `[]::jsonb` (the column default), so a literal `[]` neq is equivalent.
  const [
    abandonedCartRes,
    reviewRequestRes,
    rxRenewalRes,
    smartTriggerRes,
    pendingFaxRes,
    adminRes,
    agentRes,
    pendingRes,
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("shop_abandoned_carts")
      .select("*", { count: "exact", head: true })
      .lte("updated_at", cutoff24h)
      .is("reminded_at", null)
      .is("recovered_at", null)
      .is("cleared_at", null)
      .neq("items", "[]"),

    supabase
      .schema("resupply")
      .from("shop_orders")
      .select("*", { count: "exact", head: true })
      .eq("status", "paid")
      .lte("paid_at", reviewCutoff)
      .is("review_request_sent_at", null)
      .not("customer_id", "is", null),

    supabase
      .schema("resupply")
      .from("prescriptions")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .is("renewal_requested_at", null)
      .not("valid_until", "is", null)
      .lte("valid_until", renewalCutoff),

    supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .select("*", { count: "exact", head: true })
      .is("sent_at", null)
      .is("dismissed_at", null),

    // `pendingFax.eligibleNow` answers "would the fax dispatcher do
    // any work right now?". Counting `failed` rows here makes the
    // tile grow without bound — a fax that the vendor permanently
    // rejected six months ago still shows up as "eligible now" even
    // though no dispatcher run will retry it; the operator has to
    // open the row and manually re-queue. Restrict to `pending`
    // (truly dispatcher-eligible) so the tile shrinks back to zero
    // when the queue drains.
    supabase
      .schema("resupply")
      .from("physician_fax_outreach")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),

    supabase
      .schema("resupply")
      .from("admin_users")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .eq("role", "admin"),

    supabase
      .schema("resupply")
      .from("admin_users")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .eq("role", "agent"),

    supabase
      .schema("resupply")
      .from("admin_users")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);
  for (const r of [
    abandonedCartRes,
    reviewRequestRes,
    rxRenewalRes,
    smartTriggerRes,
    pendingFaxRes,
    adminRes,
    agentRes,
    pendingRes,
  ]) {
    if (r.error) throw r.error;
  }

  res.json({
    vendors,
    dispatchers: {
      abandonedCart: { eligibleNow: abandonedCartRes.count ?? 0 },
      reviewRequest: { eligibleNow: reviewRequestRes.count ?? 0 },
      rxRenewal: { eligibleNow: rxRenewalRes.count ?? 0 },
      smartTrigger: { eligibleNow: smartTriggerRes.count ?? 0 },
      pendingFax: { eligibleNow: pendingFaxRes.count ?? 0 },
    },
    team: {
      activeAdmins: adminRes.count ?? 0,
      activeAgents: agentRes.count ?? 0,
      pendingInvites: pendingRes.count ?? 0,
    },
    serverTime: new Date().toISOString(),
  });
});

export default router;
