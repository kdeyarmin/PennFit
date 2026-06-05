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

import { getConfigOverrides } from "../../lib/app-config/store";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { RENEWAL_WINDOW_DAYS } from "@workspace/resupply-domain";

const router: IRouter = Router();

const NUDGE_WAIT_MS = 24 * 60 * 60 * 1000;
const REVIEW_REQUEST_AGE_DAYS = 14;

// Per-vendor "are the required credentials present in THIS env?" flags.
// Pure env read — no vendor round-trip. Called twice per request: once
// against the live process.env, once against the effective env
// (process.env + System Configuration overrides from resupply.app_config)
// so a credential a super-admin just saved in the app is reflected here
// immediately instead of looking "not configured" until the next deploy.
function computeVendorFlags(env: NodeJS.ProcessEnv) {
  return {
    sendgrid: Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL),
    twilioVoice: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
    twilioSms: Boolean(
      env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_AUTH_TOKEN &&
        env.TWILIO_MESSAGING_SERVICE_SID,
    ),
    twilioFax: Boolean(
      env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_AUTH_TOKEN &&
        env.TWILIO_FAX_FROM_NUMBER &&
        (env.RESUPPLY_VOICE_PUBLIC_BASE_URL || env.RAILWAY_PUBLIC_DOMAIN),
    ),
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    objectStorage: Boolean(env.SUPABASE_STORAGE_BUCKET_PRIVATE),
  };
}

type VendorFlags = ReturnType<typeof computeVendorFlags>;

// The catalog (overridable) env keys that feed each vendor flag. Used to
// decide whether a vendor is "pending restart": a saved override whose
// value DIFFERS from the live process.env value isn't active yet — the
// running vendor clients keep using the old value until the next deploy
// folds the override in. This covers both a brand-new credential (absent
// from the live env) AND a rotation (a replacement saved while the old
// value is still live). Boot-only keys that can't be overridden (e.g.
// SUPABASE_STORAGE_BUCKET_PRIVATE, SENDGRID_FROM_EMAIL, RAILWAY_PUBLIC_DOMAIN)
// are intentionally absent — they never appear in the overrides map.
const VENDOR_CONFIG_KEYS: Record<keyof VendorFlags, readonly string[]> = {
  sendgrid: ["SENDGRID_API_KEY", "SENDGRID_FROM_NAME"],
  twilioVoice: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  twilioSms: [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_MESSAGING_SERVICE_SID",
  ],
  twilioFax: [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FAX_FROM_NUMBER",
    "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  ],
  stripe: ["STRIPE_SECRET_KEY"],
  objectStorage: [],
};

router.get(
  "/admin/ops-status",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    // Vendor flags are computed AFTER the fetch below — they depend on
    // the effective env (process.env + saved app_config overrides), which
    // is loaded alongside the dispatcher counts in the Promise.all. We
    // still don't ping the vendor APIs: boolean credential presence is
    // enough and keeps the page fast.

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
    // Count mode: the dispatcher-eligibility tiles below use
    // `count: 'estimated'` rather than `'exact'`. These ride
    // growing-base tables (shop_orders, shop_abandoned_carts,
    // prescriptions, …), and an exact PostgREST count is a full
    // COUNT(*) over every matching row on every /admin/operations
    // render. `'estimated'` returns the EXACT count while the result
    // set is small — the common case when a queue is drained or
    // nearly so — and only falls back to the planner's row estimate
    // once the eligible set is large, where the tile is a "lots of
    // work waiting" signal and ±a few doesn't change the operator's
    // decision. The team counts (admin_users) stay `'exact'`: the
    // table is tiny and the number is a precise headcount.
    //
    // Note: the original `jsonb_array_length(items) > 0` predicate on
    // shop_abandoned_carts is replaced with `.neq('items', '[]')`. PostgREST
    // doesn't expose jsonb_array_length, but a stored empty cart is always
    // `[]::jsonb` (the column default), so a literal `[]` neq is equivalent.
    const [
      overrides,
      abandonedCartRes,
      reviewRequestRes,
      rxRenewalRes,
      smartTriggerRes,
      pendingFaxRes,
      adminRes,
      agentRes,
      pendingRes,
    ] = await Promise.all([
      // Saved System Configuration overrides (catalog keys → value),
      // cached + fail-soft (degrades to "{}" on any DB hiccup). Folded
      // over process.env below so a credential saved in
      // /admin/system/configuration shows as configured here without
      // waiting for the next deploy.
      getConfigOverrides(),

      supabase
        .schema("resupply")
        .from("shop_abandoned_carts")
        .select("*", { count: "estimated", head: true })
        .lte("updated_at", cutoff24h)
        .is("reminded_at", null)
        .is("recovered_at", null)
        .is("cleared_at", null)
        .neq("items", "[]"),

      supabase
        .schema("resupply")
        .from("shop_orders")
        .select("*", { count: "estimated", head: true })
        .eq("status", "paid")
        .lte("paid_at", reviewCutoff)
        .is("review_request_sent_at", null)
        .not("customer_id", "is", null),

      supabase
        .schema("resupply")
        .from("prescriptions")
        .select("*", { count: "estimated", head: true })
        .eq("status", "active")
        .is("renewal_requested_at", null)
        .not("valid_until", "is", null)
        .lte("valid_until", renewalCutoff),

      supabase
        .schema("resupply")
        .from("patient_smart_trigger_events")
        .select("*", { count: "estimated", head: true })
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
        .select("*", { count: "estimated", head: true })
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

    // Effective = process.env with saved System Configuration overrides
    // layered on top, so a credential entered in the app reads as
    // configured here. `vendors` reports that effective state.
    const effectiveEnv =
      Object.keys(overrides).length > 0
        ? { ...process.env, ...overrides }
        : process.env;
    const effectiveFlags = computeVendorFlags(effectiveEnv);

    // "Pending restart": a saved override exists whose value DIFFERS from
    // the live process.env value, so the running vendor clients are still
    // using the old (or no) value until the next deploy folds it in
    // (catalog keys are applyMode: "restart"). Comparing values — not just
    // presence — flags a rotation too (a replacement key saved while the
    // old one is still live), which a presence-only check would miss and
    // show as a misleading green "configured".
    const pendingKeys = new Set(
      Object.keys(overrides).filter((k) => overrides[k] !== process.env[k]),
    );
    const vendorsPendingRestart = Object.fromEntries(
      (Object.keys(effectiveFlags) as Array<keyof VendorFlags>).map((k) => [
        k,
        effectiveFlags[k] &&
          VENDOR_CONFIG_KEYS[k].some((key) => pendingKeys.has(key)),
      ]),
    ) as Record<keyof VendorFlags, boolean>;

    res.json({
      vendors: effectiveFlags,
      vendorsPendingRestart,
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
  },
);

export default router;
