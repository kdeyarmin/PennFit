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
   * POST /api/recommend — public mask-scoring engine. No token cost
   * and no PHI, but it runs the full recommendation engine on the
   * single Node process per call, so it's the one hot public POST
   * left uncapped. Generous per-IP budget (a real fitter session
   * recomputes a handful of times) that still shuts down a script
   * hammering the CPU. Bumping it 10x risks event-loop starvation
   * under a flood, not cost.
   */
  storefront_recommend: {
    windowMs: 60 * 1000,
    limit: 60,
    doc: "POST /api/recommend — public mask-scoring engine, CPU-bound (no token cost, no PHI)",
  },

  /**
   * POST /api/me/sleep-coach — signed-in patient sleep coach. Every
   * accepted request burns Anthropic / OpenAI tokens (same cost shape
   * as /api/chat). Keyed by the signed-in customer id (IP fallback)
   * so one compromised or scripted session can't run up the vendor
   * bill. Looser than the public chat budget because the caller is
   * authenticated, but still bounded.
   */
  me_sleep_coach: {
    windowMs: 5 * 60 * 1000,
    limit: 30,
    doc: "POST /api/me/sleep-coach — signed-in LLM endpoint, every request burns vendor tokens",
  },

  /**
   * POST /shop/me/chat — signed-in customer support chatbot. Same
   * token-cost shape as /api/chat and the sleep coach; keyed by the
   * signed-in customer id (IP fallback). Bounds per-session LLM spend
   * if a session is scripted or compromised.
   */
  me_chat: {
    windowMs: 5 * 60 * 1000,
    limit: 40,
    doc: "POST /shop/me/chat — signed-in LLM endpoint, every request burns vendor tokens",
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
   * POST /resupply-api/stripe/webhook — Stripe-signed. Signature
   * verification (HMAC) is the primary gate; this limiter is a
   * pre-verification DoS shield so a flood of forged payloads can't
   * exhaust CPU on body parsing or the signature math. 300/min/IP
   * is well above any real Stripe delivery burst.
   */
  stripe_webhook: {
    windowMs: 60 * 1000,
    limit: 300,
    doc: "POST /resupply-api/stripe/webhook — pre-verification DoS shield, Stripe HMAC still gates body",
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
   * POST /resupply-api/email/sendgrid-events — SendGrid Event Webhook.
   * ECDSA signature verification is the real authorization gate; this
   * pre-verification DoS shield keeps a flood of unsigned/forged
   * payloads from burning CPU on body parsing or signature math.
   * 300/min/IP mirrors the Stripe webhook limiter.
   */
  sendgrid_events: {
    windowMs: 60 * 1000,
    limit: 300,
    doc: "POST /email/sendgrid-events — pre-verification DoS shield, SendGrid ECDSA still gates body",
  },

  /**
   * POST /shop/validate-address — public address-validation probe.
   * Pure local heuristic (no third-party API cost), but still a
   * public POST that should not be hammered. 60/min/IP is generous
   * for any legitimate checkout flow.
   */
  shop_validate_address: {
    windowMs: 60 * 1000,
    limit: 60,
    doc: "POST /shop/validate-address — public local-heuristic probe, no third-party cost",
  },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;
