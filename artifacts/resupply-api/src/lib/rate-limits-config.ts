// Rate-limit budgets — central registry for the public-facing tier.
//
// Why this exists
// ---------------
// Limiter windowMs + max values used to be hardcoded inline at every
// call site. Ops asking "where do I bump the chat limit from 30 to
// 60?" had to grep across ~40 files to find the literal. Worse, it
// was easy to ship a new endpoint with no rate limit at all because
// there was no canonical place to consult for "what's the standard
// budget for a public POST that hits Stripe / SendGrid / an LLM?"
//
// This file owns the budget (windowMs + limit) for every PUBLIC-
// facing limiter — anything an unauthenticated visitor can hit, plus
// the patient / provider portals which gate on cookies but still see
// untrusted traffic. ADMIN limiters keep using the preset table in
// `middlewares/admin-rate-limit.ts` (destroy / bulk / sensitive /
// mutation) — that's already the central config for that tier.
//
// Field naming
// ------------
// Uses `limit` (express-rate-limit v7+ vocabulary). Call sites using
// the custom `rateLimit()` from `middlewares/rate-limit.ts` should
// map it to `max`:  `{ windowMs: ENTRY.windowMs, max: ENTRY.limit }`.
// Both names are deliberately not duplicated on the registry entry
// so there's exactly one number to tune.
//
// Adding a new entry
// ------------------
// 1. Add the entry below with a `doc` explaining the WHY of the
//    budget — what specifically would happen if it were bumped 10x
//    (cost? PHI? spam?). That's the question ops will ask when
//    they're considering a change.
// 2. Pick a name in `<surface>.<action>` form. The name surfaces in
//    the structured `rate_limit_exceeded` log line so `grep limiter=`
//    in production logs groups by route family.

export interface RateLimitEntry {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per key per window. */
  limit: number;
  /**
   * One-sentence "why this number". Ops reads this when deciding
   * whether a tune-up is safe. Treat the doc field as required:
   * a number with no rationale is a number nobody knows how to
   * change.
   */
  doc: string;
}

export const RATE_LIMITS = {
  /**
   * POST /api/orders — fitter checkout submission. Every accepted
   * request persists patient PHI + may fire SendGrid email + SMS.
   * Hard cap: a script enumerating insurance shapes shouldn't be
   * able to drive unbounded inserts before being shut down.
   */
  storefront_orders: {
    windowMs: 10 * 60 * 1000,
    limit: 5,
    doc: "POST /api/orders — patient PHI insert + email/SMS side effects",
  },

  /**
   * POST /api/usage-events — anonymous funnel telemetry. Lower
   * blast radius than orders (no PHI, no third-party side effect)
   * so the budget is looser.
   */
  storefront_usage_events: {
    windowMs: 60 * 1000,
    limit: 30,
    doc: "POST /api/usage-events — anonymous funnel telemetry",
  },

  /**
   * POST /api/chat — public LLM gateway. Every accepted request
   * burns Anthropic / OpenAI tokens; an abusive visitor could run
   * up the bill or starve legitimate users. Tight per-IP cap is
   * the cost-control mechanism here.
   */
  storefront_chat: {
    windowMs: 5 * 60 * 1000,
    limit: 30,
    doc: "POST /api/chat — public LLM gateway, every request burns vendor tokens",
  },

  /**
   * POST /api/reminders — reminder signup. Each accepted request
   * inserts a subscription row AND fires a welcome email. Even a
   * legitimate visitor signs up once, maybe twice; tight per-IP
   * budget catches drive-by spam.
   */
  reminder_signup: {
    windowMs: 15 * 60 * 1000,
    limit: 5,
    doc: "POST /api/reminders — DB insert + welcome email per signup",
  },

  /**
   * GET/POST /api/reminders/manage* — patient self-service
   * keyed by the 64-char capability token. Generous because a
   * patient legitimately fiddling with cadence may hit ~10
   * endpoints in one session; the token already gates access to
   * one subscription only, so spam-from-a-shared-IP isn't a real
   * concern.
   */
  reminder_manage: {
    windowMs: 15 * 60 * 1000,
    limit: 60,
    doc: "GET/POST /api/reminders/manage* — token-keyed patient self-service",
  },

  /**
   * Vendor push webhooks (ResMed AirView, Philips Care, React
   * Health). HMAC verification is the primary authorization gate;
   * this is purely a pre-verification DoS shield so a flood of
   * forged requests can't burn CPU on signature math or audit-log
   * writes. 300/min/IP is well above the burstiest vendor push
   * volume.
   */
  integrations_inbound_webhooks: {
    windowMs: 60 * 1000,
    limit: 300,
    doc: "POST /integrations/webhooks/* — pre-verification DoS shield, HMAC still gates body",
  },

  /**
   * Partner-side ingest (Parachute referrals, EHR FHIR pushes).
   * 120/min/IP because Parachute's own retry storm caps at ~30/min
   * and the rate exists to stop scripted abuse, not throttle a
   * real partner. Lower than the webhook tier because these
   * inserts hit the DB write path immediately.
   */
  integrations_inbound_dispatch: {
    windowMs: 60 * 1000,
    limit: 120,
    doc: "POST /integrations/inbound/* — partner referral/FHIR ingest, immediate DB write",
  },

  /**
   * Provider portal (the prescriber-facing surface). Login-gated
   * but the public-facing prescriber discovery pages can flood
   * before auth; per-IP cap absorbs that.
   */
  provider_portal: {
    windowMs: 60 * 1000,
    limit: 60,
    doc: "Provider portal — prescriber-facing, public discovery + login flow",
  },

  /**
   * Clinician portal — same posture as provider_portal but for the
   * sleep-physician surface (which has different SSO routing and
   * therefore a separate mount).
   */
  portal_clinician: {
    windowMs: 60 * 1000,
    limit: 60,
    doc: "Clinician portal — sleep-physician surface, separate SSO mount",
  },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;
