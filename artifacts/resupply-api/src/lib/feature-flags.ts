// Feature flag runtime helper.
//
// Backed by `resupply.feature_flags`, which is PER-TENANT since Phase 1
// (migration 0350 re-keyed it from (key) to (org_id, key)). Provides:
//   * `isFeatureEnabled(key, orgId?)` — process-cached lookup used by
//     route handlers, dispatchers, and worker jobs to gate work behind an
//     admin-flippable boolean. Pass `req.orgId` to honor the caller's
//     tenant; omit it (worker/system paths) to use the seed tenant. A
//     tenant with no row of its own falls back to the seed tenant's value
//     (the platform default).
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

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "./logger";

/**
 * Every feature flag the catalog supports. Keep this list in lockstep
 * with the seed migration in
 * lib/resupply-db/migrations/0149_feature_flags.sql — a typo here vs.
 * there means the toggle in the admin UI silently no-ops.
 */
export const FEATURE_FLAG_KEYS = [
  "sms.reminders",
  "email.reminders",
  "email.auto_reply",
  "voice.agent",
  "telehealth.video",
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
  "billing.auto_submit_prior_auths",
  "billing.eligibility_precheck",
  "billing.eligibility_precheck_refresh",
  "insurance.discovery",
  "billing.line_ordering_provider",
  "billing.payment_plan_autocharge",
  "billing.patient_autopay",
  "billing.auto_secondary_claims",
  "smart_triggers.dispatcher",
  "patient_onboarding.dispatcher",
  "fitter_supply_campaign.dispatcher",
  "resupply.entitlement_enforcement",
  "resupply.eligibility_enforcement",
  "resupply.usage_compliance_check",
  "resupply.refill_affirmation_capture",
  "resupply.refill_window_enforcement",
  "resupply.auto_order_drafts",
  // Lifecycle close-out (migration 0538). Both seed OFF: each changes
  // when a live patient is next contacted, so they are flipped per
  // tenant after that tenant's backfill dry-run comes back clean.
  "resupply.due_at_authoritative",
  "resupply.ship_evidence_required",
  "reminder_escalation.dispatcher",
  "reminder_escalation.voice",
  "voice.breathe_sales",
  "storefront.auto_reminder_enrollment",
  "alerts.auto_dispatch",
  "therapy_fleet.auto_outreach",
  "clinical_outreach.dispatcher",
  "eligibility.auto_reverify",
  "fitter_first_day_nudge.dispatcher",
  "fitter_reengage.dispatcher",
  "failed_email_digest.dispatcher",
  "patient_packets.autosend_on_delivery",
  "patient_packets.autoremind",
  "patient_packets.autofile_signed_pdf",
  "orders.require_signed_paperwork",
  "provider.portal_enabled",
  "multi_location.enabled",
  "billing.bill_hold",
  "billing.bill_hold_auto_remind",
  "billing.adr_queue",
  "collections.dunning",
  "collections.agency_export",
  "fax.auto_file_signed",
  "fax.referral_review",
  "frontdesk.counter_orders",
  "asset_recovery.auto_populate",
  "domains.tls_automation",
  "support.tickets",
  "referrals.adherence_report",
  "slack.notifications",
  "slack.interactivity",
  "slack.digests",
  // Clinical fitting core (migration 0485). Every patient-visible one is
  // seeded OFF; `fitter.clinical_assessment` is the master switch the
  // others depend on.
  "fitter.clinical_assessment",
  "fitter.multiframe_capture",
  "fitter.fit_profile_v2",
  "fitter.magnet_screening",
  "fitter.confidence_gating",
  "fitter.clinical_report",
  // App modules (migration 0488). Unlike every key above — which gates a
  // BEHAVIOUR (does the dispatcher send? does auto-submit run?) — a
  // `module.*` key gates a NAVIGABLE part of the admin console. Turning
  // one off removes its section from the sidebar and turns a deep link
  // into a "this part of the app is turned off" notice, so a tenant only
  // navigates the parts of the product it actually uses. All seeded ON.
  //
  // These are scope controls, not authorization: the server-side
  // requireAdmin / requirePermission gates are unchanged, and no data is
  // deleted or made unreachable by an API client. Keep the list in
  // lockstep with migration 0488 and with APP_MODULES in
  // artifacts/cpap-fitter/src/lib/admin/app-modules.ts.
  "module.front_desk",
  "module.conversations",
  "module.schedule",
  "module.outreach",
  "module.documents",
  "module.therapy",
  "module.clinical",
  "module.providers",
  "module.storefront",
  "module.inventory",
  "module.billing",
  "module.analytics",
  "module.automation",
  "module.integrations",
  "module.support",
  // Proactive re-fit outreach to patients already on service (0490).
  // Seeded OFF — unsolicited patient contact is the tenant's call.
  "fitter.refit_campaign",
  // End the fitter with a REQUEST a person works, not an order the
  // patient files themselves (migration 0518). The one fitter flag
  // seeded ON, and the one that fails toward ENABLED on a degraded
  // lookup: putting a human between a patient's guess at their member ID
  // and a claim is the safe direction, so an unresolvable flag must not
  // hand them the self-serve order form.
  "fitter.lead_capture_only",
  // Follow up when a fitter link goes unanswered (migration 0536).
  // Seeded ON: unlike the re-fit campaign above, this is a second
  // message on a thread the TENANT started by sending this person a
  // link, and the sweep is structurally incapable of chasing a backlog
  // (cohort A only touches invites still inside their own expiry;
  // cohort B looks back 30 days). Gates the PATIENT messages only —
  // the staff worklist is built either way.
  "fitter.followup_nudges",
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
  /** True when `value` is a fail-open/closed fallback from a FAILED
   *  lookup, not a value actually read from the flag table. Cached so a
   *  state-aware caller inside the short failure window still sees the
   *  degradation instead of mistaking the fallback for a tenant choice. */
  degraded: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

class FeatureFlagLookupTimeout extends Error {
  constructor() {
    super("feature_flag_lookup_timeout");
    this.name = "FeatureFlagLookupTimeout";
  }
}

/** Race a lookup against the bounded timeout (see LOOKUP_TIMEOUT_MS). */
async function withLookupTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new FeatureFlagLookupTimeout()),
      LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the enabled state of `(orgId, key)` directly from Supabase,
 * with a fallback to the seed tenant's row when this org has no row of
 * its own (a not-yet-provisioned tenant reads the platform default), and
 * finally to "enabled" for an entirely unknown key. Bounded by
 * LOOKUP_TIMEOUT_MS. Throws on a real DB error so the caller's
 * fail-closed/open logic applies.
 */
async function lookupEnabled(
  orgId: string,
  key: FeatureFlagKey,
  seedOrgId: string | null,
): Promise<boolean> {
  return withLookupTimeout(async () => {
    // Tenant-scoped read through the org chokepoint — the facade appends
    // `.eq("org_id", orgId)` for us (feature_flags is per-tenant since
    // Phase 1 / migration 0350).
    const { data, error } = await getOrgScopedClient(orgId)
      .from("feature_flags")
      .select("enabled")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (data) return data.enabled;
    // No row for this org. Fall back to the seed org's value (the
    // platform default) when we're looking at some OTHER org; otherwise
    // treat an unknown key as enabled (matches the table's posture).
    if (seedOrgId && orgId !== seedOrgId) {
      const { data: seedData, error: seedErr } = await getOrgScopedClient(
        seedOrgId,
      )
        .from("feature_flags")
        .select("enabled")
        .eq("key", key)
        .maybeSingle();
      if (seedErr) throw seedErr;
      if (seedData) return seedData.enabled;
    }
    return true;
  });
}

/**
 * Returns true when the named feature is enabled for a tenant. Always
 * reads from the process-local cache when fresh; falls through to
 * Supabase otherwise. See file header for fail-closed posture.
 *
 * `orgId` selects the tenant. When omitted (worker/system paths with no
 * request context), the seed tenant is used — so the ~74 existing
 * `isFeatureEnabled(key)` call sites keep their single-tenant behavior.
 * Request handlers that should honor the caller's tenant pass
 * `req.orgId`.
 *
 * The key parameter is typed as the closed `FeatureFlagKey` union so
 * the compiler catches typos at call sites — `isFeatureEnabled("sms.reminder")`
 * (missing the trailing 's') would not compile.
 */
export async function isFeatureEnabled(
  key: FeatureFlagKey,
  orgId?: string,
): Promise<boolean> {
  return (await getFeatureFlagState(key, orgId)).enabled;
}

/**
 * The lookup result WITH its provenance: `degraded` is true when the
 * boolean is a fail-open/closed fallback (DB error, timeout, no tenant
 * resolvable) rather than a value actually read for the tenant.
 *
 * Why this exists: `isFeatureEnabled` never rejects — every failure is
 * absorbed into its fail-open (non-prod) / fail-closed (prod) posture —
 * so a caller's `.catch(() => true)` around it is dead code. A SAFETY
 * flag (e.g. `fitter.magnet_screening`) must fail toward "screening
 * required", which for that flag means treating a failed lookup as ON:
 * resolve it as `state.enabled || state.degraded`. A tenant's explicit
 * opt-out still reads as `{ enabled: false, degraded: false }` and is
 * honored; only a lookup that never reached the tenant's row is
 * overridden. Never rejects, same as `isFeatureEnabled`.
 */
export interface FeatureFlagState {
  enabled: boolean;
  degraded: boolean;
}

export async function getFeatureFlagState(
  key: FeatureFlagKey,
  orgId?: string,
): Promise<FeatureFlagState> {
  const now = Date.now();
  // Built per (org, key). Hoisted so the catch block caches a failure
  // under the same entry a retry will read.
  let cacheKey = orgId ? `${orgId}:${key}` : key;

  try {
    // Bound the seed-org resolution: it's an extra DB round-trip on this
    // hot path and, unlike the flag lookup itself, carries no timeout of
    // its own. A degraded/unreachable DB must not let it hang the caller
    // (e.g. a checkout request) — a timeout degrades to "unresolved",
    // which falls through to the legacy key-only path + the catch block's
    // fail-closed/open posture. Resolves instantly from cache once warm.
    let seedOrgId: string | null = null;
    try {
      seedOrgId = await withLookupTimeout(() => resolveSeedOrgId());
    } catch {
      seedOrgId = null;
    }
    const effectiveOrgId = orgId ?? seedOrgId;

    if (!effectiveOrgId) {
      // No tenant resolvable (no orgId AND the seed org couldn't be
      // resolved — e.g. a dev/test/CI env with no DB, or before the
      // organizations row exists). feature_flags is per-tenant since
      // Phase 1, so there is no tenant row to read; defer to the catch
      // block's posture (enabled in non-prod, fail-closed in prod) by
      // signalling an unreachable lookup. This matches the pre-Phase-1
      // reader's effective behavior, where the key-only DB read also
      // threw (no/unreachable DB) and fell through to the same catch.
      cacheKey = key;
      throw new FeatureFlagLookupTimeout();
    }

    cacheKey = `${effectiveOrgId}:${key}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { enabled: cached.value, degraded: cached.degraded };
    }

    const value = await lookupEnabled(effectiveOrgId, key, seedOrgId);
    cache.set(cacheKey, {
      value,
      degraded: false,
      expiresAt: now + CACHE_TTL_MS,
    });
    return { enabled: value, degraded: false };
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
      cache.set(cacheKey, {
        value: true,
        degraded: true,
        expiresAt: now + CACHE_TTL_MS,
      });
      return { enabled: true, degraded: true };
    }
    if (isUnreachable && process.env.NODE_ENV !== "production") {
      // Supabase is configured but unreachable AND we're not in
      // production — likely a dev/CI run pointing at a stand-in
      // host. Fall through to enabled so dispatchers stay testable.
      // In production an unreachable DB is a real outage; the file
      // header pins fail-CLOSED posture, so we fall through to the
      // fail-closed branch below instead.
      cache.set(cacheKey, {
        value: true,
        degraded: true,
        expiresAt: now + CACHE_TTL_MS,
      });
      return { enabled: true, degraded: true };
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
    cache.set(cacheKey, {
      value: false,
      degraded: true,
      expiresAt: now + 1_000,
    });
    return { enabled: false, degraded: true };
  }
}

// ── Bulk read: which flags are OFF for a tenant ───────────────────────
//
// `isFeatureEnabled` is the right shape for a route asking about ONE
// flag. The admin SPA needs the opposite: a single answer covering the
// whole catalog, so it can subtract disabled modules from the sidebar in
// one pass without ~90 round-trips on every /me.
//
// We return the DISABLED set rather than the enabled one on purpose:
// it's the shorter list (flags are overwhelmingly on), and — more
// importantly — it degrades in the safe direction. An empty result means
// "nothing is hidden", so a client that fails to read this, or reads it
// during a blip, shows the full console rather than an empty sidebar.

const disabledCache = new Map<string, { keys: string[]; expiresAt: number }>();

/** Rows for one org, or null when the org has no feature_flags rows. */
async function readFlagRows(
  orgId: string,
): Promise<Array<{ key: string; enabled: boolean }> | null> {
  const { data, error } = await getOrgScopedClient(orgId)
    .from("feature_flags")
    .select("key, enabled");
  if (error) throw error;
  const rows = (data ?? []) as Array<{ key: string; enabled: boolean }>;
  return rows.length > 0 ? rows : null;
}

/**
 * Every flag key currently turned OFF for `orgId`, mirroring
 * `isFeatureEnabled`'s per-tenant resolution: a tenant with no rows of
 * its own inherits the seed tenant's catalog (the platform default).
 *
 * Posture — deliberately the OPPOSITE of `isFeatureEnabled`. That
 * function fails CLOSED (a flag whose state we can't read is treated as
 * off) because the things it gates SEND: texts, calls, claims, charges.
 * Doing something on bad information is worse than doing nothing.
 *
 * This function only decides what the console DRAWS. Failing closed here
 * would mean an unreachable database empties an operator's sidebar
 * mid-shift — a self-inflicted outage of the UI, on a signal that grants
 * no access either way (every route behind those nav entries is still
 * gated server-side by requireAdmin / requirePermission). So a read
 * failure yields an EMPTY set: show everything, hide nothing, and let
 * the real gates do the real work.
 */
export async function listDisabledFeatures(orgId?: string): Promise<string[]> {
  const now = Date.now();
  try {
    let seedOrgId: string | null = null;
    try {
      seedOrgId = await withLookupTimeout(() => resolveSeedOrgId());
    } catch {
      seedOrgId = null;
    }
    const effectiveOrgId = orgId ?? seedOrgId;
    if (!effectiveOrgId) return [];

    const cached = disabledCache.get(effectiveOrgId);
    if (cached && cached.expiresAt > now) return cached.keys;

    const rows = await withLookupTimeout(async () => {
      const own = await readFlagRows(effectiveOrgId);
      if (own) return own;
      // Un-provisioned tenant: inherit the seed catalog, same as the
      // single-key path does.
      if (seedOrgId && effectiveOrgId !== seedOrgId) {
        return (await readFlagRows(seedOrgId)) ?? [];
      }
      return [];
    });

    const keys = rows
      .filter((r) => !r.enabled)
      .map((r) => r.key)
      .sort();
    disabledCache.set(effectiveOrgId, { keys, expiresAt: now + CACHE_TTL_MS });
    return keys;
  } catch (err) {
    logger.warn(
      { event: "feature_flag_bulk_lookup_failed", err },
      "disabled-feature lookup failed; reporting none disabled (show everything)",
    );
    return [];
  }
}

/**
 * Drop cached entries so a recent toggle write becomes visible. Pass
 * a key to invalidate a single flag; pass nothing to clear everything
 * (used by tests).
 */
export function invalidateFeatureFlagCache(key?: FeatureFlagKey): void {
  // The bulk (per-org) cache holds every key for an org, so a single-key
  // toggle invalidates it wholesale either way.
  disabledCache.clear();
  if (!key) {
    cache.clear();
    return;
  }
  // Cache entries are keyed `${orgId}:${key}` (or the bare key in the
  // degraded no-org path), so drop every tenant's entry for this flag.
  const suffix = `:${key}`;
  for (const cacheKey of cache.keys()) {
    if (cacheKey === key || cacheKey.endsWith(suffix)) cache.delete(cacheKey);
  }
}
