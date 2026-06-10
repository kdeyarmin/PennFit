// Feature flag runtime helper.
//
// Backed by `resupply.feature_flags` (migration 0149). Provides:
//   * `isFeatureEnabled(key)` — process-cached lookup used by route
//     handlers, dispatchers, and worker jobs to gate work behind an
//     admin-flippable boolean.
//   * `invalidateFeatureFlagCache(key?)` — drop cached entries; called
//     by the admin-toggle endpoint after a successful write so the
//     change takes effect within the next request, not after a deploy.
//   * `FEATURE_FLAG_KEYS` — closed enum of every key the seed
//     migration creates. Adding a new key requires updating both the
//     migration and this list so a typo on either side trips at boot.
//
// Posture
// -------
//   * Fails CLOSED on a database read error: if we can't talk to
//     Supabase we report the feature as DISABLED. This keeps a
//     compromised or unreachable flag table from accidentally re-
//     enabling something operators thought they had turned off, at
//     the cost of a few seconds of disabled-features during a brief
//     outage. The alternative ("fail open / read-error means
//     enabled") risks shipping SMS or starting voice calls during
//     incidents.
//   * Unknown keys (not in the seed table) report ENABLED. This
//     matches the "default to on" posture of the table itself —
//     new features ship enabled and don't break if their seed row
//     hasn't landed yet on a slow-migrating environment.
//   * Cache TTL is short (5s) so a flag toggle from the admin UI
//     propagates without polling, but we don't hammer Supabase on
//     every webhook.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "./logger";

/**
 * Every feature flag the catalog supports. Keep this list in lockstep
 * with the seed migration in
 * lib/resupply-db/drizzle/0149_feature_flags.sql — a typo here vs.
 * there means the toggle in the admin UI silently no-ops.
 */
export const FEATURE_FLAG_KEYS = [
  "sms.reminders",
  "email.reminders",
  "email.auto_reply",
  "voice.agent",
  "storefront.chatbot",
  "admin.assistant",
  "storefront.checkout",
  "storefront.pickup",
  "storefront.reviews_collection",
  "storefront.nps",
  "bulk_campaigns.send",
  "outreach_playbooks.dispatcher",
  "cart_abandonment.dispatcher",
  "ai_billing.suggestions",
  "billing.auto_submit_claims",
  "billing.eligibility_precheck",
  "billing.eligibility_precheck_refresh",
  "billing.line_ordering_provider",
  "billing.payment_plan_autocharge",
  "billing.patient_autopay",
  "smart_triggers.dispatcher",
  "patient_onboarding.dispatcher",
  "fitter_supply_campaign.dispatcher",
  "resupply.entitlement_enforcement",
  "resupply.eligibility_enforcement",
  "resupply.usage_compliance_check",
  "reminder_escalation.dispatcher",
  "storefront.auto_reminder_enrollment",
  "alerts.auto_dispatch",
  "therapy_fleet.auto_outreach",
  "clinical_outreach.dispatcher",
  "eligibility.auto_reverify",
  "fitter_first_day_nudge.dispatcher",
  "fitter_reengage.dispatcher",
  "failed_email_digest.dispatcher",
  "inbound_referrals.dispatcher",
  "patient_packets.autosend_on_delivery",
  "patient_packets.autoremind",
  "patient_packets.autofile_signed_pdf",
  "orders.require_signed_paperwork",
  "provider.portal_enabled",
  "multi_location.enabled",
  "billing.bill_hold",
  "billing.bill_hold_auto_remind",
  "fax.auto_file_signed",
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

const CACHE_TTL_MS = 5_000;

/**
 * Bound the Supabase round-trip. A feature-flag lookup is a hot path
 * — every checkout, every voice call, every chat message will hit it
 * — so we never want it to block a request for more than ~1.5s
 * waiting on the DB. Hits beyond this window fall through to the
 * fail-open / fail-closed branch in the catch block.
 */
const LOOKUP_TIMEOUT_MS = 1_500;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

class FeatureFlagLookupTimeout extends Error {
  constructor() {
    super("feature_flag_lookup_timeout");
    this.name = "FeatureFlagLookupTimeout";
  }
}

/**
 * Returns true when the named feature is enabled. Always reads from
 * the process-local cache when fresh; falls through to Supabase
 * otherwise. See file header for fail-closed posture.
 *
 * The key parameter is typed as the closed `FeatureFlagKey` union so
 * the compiler catches typos at call sites — `isFeatureEnabled("sms.reminder")`
 * (missing the trailing 's') would not compile.
 */
export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const supabase = getSupabaseServiceRoleClient();
    const lookup = supabase
      .schema("resupply")
      .from("feature_flags")
      .select("enabled")
      .eq("key", key)
      .maybeSingle();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new FeatureFlagLookupTimeout()),
        LOOKUP_TIMEOUT_MS,
      );
    });
    let result: Awaited<typeof lookup>;
    try {
      result = await Promise.race([lookup, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const { data, error } = result;
    if (error) throw error;
    // Unknown key → default to enabled (matches the table's posture).
    const value = data?.enabled ?? true;
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch (err) {
    // The supabase client throws plain Error subclasses for missing
    // env vars; PostgREST errors arrive as `{ message, code }`
    // objects. Coerce both into a string.
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message?: unknown }).message ?? "unknown")
          : "unknown";
    // Distinguish "no Supabase configured at all" (dev / test
    // environments without SUPABASE_URL) from "Supabase is
    // configured but the read failed" (real outage). The first case
    // means the feature flag system can't operate AT ALL and
    // failing closed would break every dispatcher in dev; treat it
    // as "all features enabled" (the table's default posture). The
    // second case retains the fail-closed posture.
    const isMissingDbConfig =
      message.startsWith("SUPABASE_URL must be set") ||
      message.startsWith("SUPABASE_SERVICE_ROLE_KEY must be set");
    // Smoke tests and ad-hoc dev environments point SUPABASE_URL at
    // a placeholder host (e.g. http://127.0.0.1:1) that doesn't
    // actually respond. Treat a connection-refused / DNS-failure /
    // bounded-timeout as "Supabase isn't reachable here" and fall
    // through to the all-features-enabled branch so the rest of the
    // app stays usable. A real production outage (Supabase up but
    // returning errors / 5xx) still hits the fail-closed branch
    // below.
    const isUnreachable =
      err instanceof FeatureFlagLookupTimeout ||
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND") ||
      message.includes("EAI_AGAIN") ||
      message.includes("fetch failed");
    if (isMissingDbConfig && process.env.NODE_ENV !== "production") {
      // No Supabase configured at all — dev / smoke environment.
      // Fall through to "all features enabled" so the rest of the
      // app remains usable without a DB. In production this branch
      // shouldn't be reachable (env-check.ts refuses to boot), but
      // we still fail CLOSED on the off-chance the boot-time gate
      // was bypassed or regressed — silently running with every
      // feature enabled is worse than disabled.
      cache.set(key, { value: true, expiresAt: now + CACHE_TTL_MS });
      return true;
    }
    if (isUnreachable && process.env.NODE_ENV !== "production") {
      // Supabase is configured but unreachable AND we're not in
      // production — likely a dev/CI run pointing at a stand-in
      // host. Fall through to enabled so dispatchers stay testable.
      // In production an unreachable DB is a real outage; the file
      // header pins fail-CLOSED posture, so we fall through to the
      // fail-closed branch below instead.
      cache.set(key, { value: true, expiresAt: now + CACHE_TTL_MS });
      return true;
    }
    logger.warn(
      {
        event: "feature_flag_lookup_failed",
        key,
        err: message,
      },
      "feature flag lookup failed; failing closed (disabled)",
    );
    // Cache the failure for a SHORT window so a downed DB doesn't
    // turn into a per-request 503 storm. The next request after the
    // TTL expires tries again.
    cache.set(key, { value: false, expiresAt: now + 1_000 });
    return false;
  }
}

/**
 * Drop cached entries so a recent toggle write becomes visible. Pass
 * a key to invalidate a single flag; pass nothing to clear everything
 * (used by tests).
 */
export function invalidateFeatureFlagCache(key?: FeatureFlagKey): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}
