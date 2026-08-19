// Plan → feature-flag presets.
//
// A new tenant used to inherit ALL feature flags turned ON (the
// `tenant:onboard` script copied the seed tenant's full catalog with every
// `enabled` left as-is). That left an operator reviewing the entire toggle
// catalog at signup and handed, say, a Launch tenant the same automation a
// Scale tenant gets. This module instead expresses, per billing plan, the
// set of flags that should default to ON — so onboarding can apply a
// sensible "bundle" for the chosen plan and the operator reviews nothing in
// the common case. Every flag remains individually toggleable afterward in
// the admin Control Center; these are starting defaults, not a hard gate.
//
// The presets mirror the MARKETED tiers (billing_plans.features, migration
// 0362), made cumulative: Launch ⊂ Growth ⊂ Scale ⊂ Enterprise.
// `mask_fitter` is the fitter-only DME (product scope gates the console to
// the AI mask fitter), so it gets a minimal send-the-fitting-link bundle.
//
// PURITY: this is plain data — no DB, no I/O — so the `tenant:onboard`
// script (@workspace/scripts) and the API can both import it. The flag keys
// are strings here; a drift test in @workspace/resupply-api cross-checks
// every key against the canonical `FEATURE_FLAG_KEYS` enum so a typo on
// either side fails CI.

export type BillingPlanCode =
  | "mask_fitter"
  | "launch"
  | "growth"
  | "scale"
  | "enterprise";

// ── Flag groups (the building blocks of the cumulative presets). ──────────
// Group names are documentation; the union of all groups (plus the two
// deliberately-OFF flags below) must equal the full FEATURE_FLAG_KEYS enum,
// which the drift test asserts.

/** In-app helpers + operational hygiene every tenant gets. */
const CORE_OPERATIONS = [
  "admin.assistant",
  "failed_email_digest.dispatcher",
] as const;

/** AI mask-fitter outreach — on for the fitter-only plan AND full suites. */
const FITTER = [
  "fitter_supply_campaign.dispatcher",
  "fitter_first_day_nudge.dispatcher",
  "fitter_reengage.dispatcher",
  // The clinical fit report (PDF). Staff-only and purely additive — it
  // reads a fit session that already exists and renders it. Every plan
  // that includes the fitter should be able to print one.
  "fitter.clinical_report",
  // The clinical fitting core (migration 0485, turned on by 0500). These
  // three moved out of DELIBERATELY_OFF_FLAGS when the RT sign-off gate
  // was removed from `resolveConfidence`: the reason they were opt-in was
  // that seeded size bands are estimates and a clinician had to vouch for
  // them first, and that requirement is gone.
  //
  // They travel TOGETHER and should not be split:
  //   * clinical_assessment is the master switch — the other two are
  //     inert without it.
  //   * magnet_screening is what asks about pacemakers, ICDs and
  //     neurostimulators. Engine on + screening off means nobody is
  //     asked, which is worse than the engine being off.
  //   * confidence_gating is what makes the SCAN's verdict binding —
  //     without it an implausible measurement still yields a confident
  //     answer and every low_confidence result is upgraded to moderate.
  "fitter.clinical_assessment",
  "fitter.magnet_screening",
  "fitter.confidence_gating",
] as const;

/** Resupply reminders — the Launch-tier core. */
const REMINDERS = [
  "sms.reminders",
  "email.reminders",
  "reminder_escalation.dispatcher",
] as const;

/** Branded storefront + shop/checkout + customer touchpoints. */
const STOREFRONT = [
  "storefront.chatbot",
  "storefront.checkout",
  "storefront.pickup",
  "storefront.reviews_collection",
  "storefront.nps",
  "storefront.auto_reminder_enrollment",
  "cart_abandonment.dispatcher",
  "support.tickets",
  "domains.tls_automation",
] as const;

/** Resupply eligibility/usage engine + patient onboarding (Launch core). */
const RESUPPLY_ENGINE = [
  "patient_onboarding.dispatcher",
  "resupply.entitlement_enforcement",
  "resupply.eligibility_enforcement",
  "resupply.usage_compliance_check",
  "resupply.refill_affirmation_capture",
  "resupply.refill_window_enforcement",
  "resupply.auto_order_drafts",
] as const;

/** Bulk campaigns, playbooks, smart triggers (Growth). */
const OUTREACH = [
  "bulk_campaigns.send",
  "outreach_playbooks.dispatcher",
  "smart_triggers.dispatcher",
  "clinical_outreach.dispatcher",
] as const;

/** Patient packets, e-signature, inbound fax/referral triage (Growth). */
const DOCUMENTS = [
  "inbound_referrals.dispatcher",
  "patient_packets.autosend_on_delivery",
  "patient_packets.autoremind",
  "patient_packets.autofile_signed_pdf",
  "orders.require_signed_paperwork",
  "fax.auto_file_signed",
  "fax.referral_review",
  "referrals.adherence_report",
] as const;

/** Eligibility, prior auth, CMN/bill-hold, A/R, collections (Growth). */
const BILLING = [
  "ai_billing.suggestions",
  "billing.eligibility_precheck",
  "billing.eligibility_precheck_refresh",
  "eligibility.auto_reverify",
  "insurance.discovery",
  "billing.auto_submit_claims",
  "billing.auto_submit_prior_auths",
  "billing.auto_secondary_claims",
  "billing.line_ordering_provider",
  "billing.payment_plan_autocharge",
  "billing.patient_autopay",
  "billing.bill_hold",
  "billing.bill_hold_auto_remind",
  "billing.adr_queue",
  "collections.dunning",
  "collections.agency_export",
  "asset_recovery.auto_populate",
] as const;

/** Therapy-cloud monitoring + provider portal (Growth). */
const THERAPY = [
  "therapy_fleet.auto_outreach",
  "provider.portal_enabled",
] as const;

/** Multi-location, voice/video, live alerts, front desk, Slack (Scale). */
const SCALE_AUTOMATION = [
  "multi_location.enabled",
  "voice.agent",
  "reminder_escalation.voice",
  "telehealth.video",
  "alerts.auto_dispatch",
  "frontdesk.counter_orders",
  "slack.notifications",
  "slack.interactivity",
  "slack.digests",
] as const;

/**
 * Flags a preset NEVER turns on automatically, regardless of plan. They stay
 * OFF until an operator deliberately enables them in the Control Center:
 *   * `email.auto_reply` — seeded OFF by design (migration 0250 / ADR 013
 *     departure: free-text email otherwise goes to a human).
 *   * `voice.breathe_sales` — the platform's own sales-outreach agent, not a
 *     tenant-facing feature.
 *   * The clinical-fitting flags that change how the patient is ASKED or
 *     MEASURED, rather than whether the engine runs at all.
 *     `fitter.multiframe_capture` changes the capture UX (it widens the
 *     high-confidence window; it is not needed to reach one — a single
 *     frame at quality >= 0.9 already clears the 0.75 scan floor).
 *     `fitter.fit_profile_v2` swaps 11 questions for ~20.
 *     `fitter.refit_campaign` drives outbound re-fit invitations.
 *
 *     Note what is NO LONGER here: `fitter.clinical_assessment`,
 *     `fitter.magnet_screening` and `fitter.confidence_gating` moved into
 *     the FITTER bundle (migration 0500). They were opt-in because the
 *     seeded size bands are estimates and an RT had to sign them off
 *     first; `resolveConfidence` no longer consults
 *     `needs_clinical_review`, so that blocker is gone, and leaving the
 *     engine off meant the face scan never actually chose the mask.
 *
 * Listed here (rather than merely omitted) so the drift test can assert the
 * full enum is accounted for and a newly-added flag can't silently fall
 * through to "off everywhere" unnoticed.
 */
export const DELIBERATELY_OFF_FLAGS = [
  "email.auto_reply",
  "voice.breathe_sales",
  "fitter.multiframe_capture",
  "fitter.fit_profile_v2",
  "fitter.refit_campaign",
] as const;

const uniq = (keys: readonly string[]): readonly string[] => [...new Set(keys)];

const MASK_FITTER = uniq([
  ...CORE_OPERATIONS,
  ...FITTER,
  "sms.reminders",
  "email.reminders",
]);

const LAUNCH = uniq([
  ...CORE_OPERATIONS,
  ...FITTER,
  ...REMINDERS,
  ...STOREFRONT,
  ...RESUPPLY_ENGINE,
]);

const GROWTH = uniq([
  ...LAUNCH,
  ...OUTREACH,
  ...DOCUMENTS,
  ...BILLING,
  ...THERAPY,
]);

const SCALE = uniq([...GROWTH, ...SCALE_AUTOMATION]);

// Enterprise = everything Scale enables (custom contracts tune from there).
const ENTERPRISE = SCALE;

/**
 * The set of feature flags that default to ON for each billing plan. The
 * complement (every other flag in the catalog) defaults to OFF at
 * onboarding. Consumed by `resolvePlanFlagPreset`.
 */
export const PLAN_FEATURE_FLAG_PRESETS: Record<
  BillingPlanCode,
  readonly string[]
> = {
  mask_fitter: MASK_FITTER,
  launch: LAUNCH,
  growth: GROWTH,
  scale: SCALE,
  enterprise: ENTERPRISE,
};

/**
 * Flag-key prefixes the plan presets do not govern.
 *
 * `module.*` (migration 0488) answers "which parts of the console does
 * this tenant want to see?" — a navigation preference the tenant sets for
 * itself, not an entitlement their plan grants. Feeding those keys through
 * the preset machinery would be actively destructive in both directions:
 * a preset apply would silently re-show every section an operator
 * deliberately hid, and — because a preset turns OFF everything it does
 * not list — a plan bundle that forgot to enumerate them would empty a
 * tenant's sidebar entirely at onboarding.
 *
 * So preset consumers skip these keys: they are neither turned on nor
 * turned off by a bundle, and they keep whatever value the tenant (or the
 * seed catalog) already had.
 */
export const PRESET_EXEMPT_FLAG_PREFIXES = ["module."] as const;

/** True for a flag the plan presets deliberately do not govern. */
export function isPresetExemptFlag(key: string): boolean {
  return PRESET_EXEMPT_FLAG_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Resolve the default-ON flag set for a plan code as a Set for O(1) lookup.
 *
 * Returns `null` for an unknown / empty plan code — the caller should then
 * fall back to its legacy behavior (copy the seed catalog's enabled state
 * as-is) rather than disabling everything. This keeps `tenant:onboard
 * --plan` omitted (or pointed at a future/unseeded plan) safe.
 */
export function resolvePlanFlagPreset(
  planCode: string | null | undefined,
): ReadonlySet<string> | null {
  if (!planCode) return null;
  // Founder pricing twins (migration 0426: launch_founder, growth_founder,
  // scale_founder, mask_fitter_founder) carry the same feature bundle as their
  // base plan — they only differ on price. Normalize the suffix before lookup
  // so founder tenants get a preset instead of falling through to no_plan.
  const base = planCode.endsWith("_founder")
    ? planCode.slice(0, -"_founder".length)
    : planCode;
  const preset = PLAN_FEATURE_FLAG_PRESETS[base as BillingPlanCode];
  if (!preset) return null;
  return new Set(preset);
}
