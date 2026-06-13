import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import compression from "compression";
import cors from "cors";
import pinoHttp from "pino-http";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { makeAuthRouter, type AuthDeps } from "@workspace/resupply-auth";
import { registerAuditRequestIdResolver } from "@workspace/resupply-audit";
import { applyEnvAliases } from "@workspace/resupply-secrets";
import router from "./routes";
import storefrontRouter from "./routes/storefront";
import providerPortalRouter from "./routes/provider";
import { getAuthDeps } from "./lib/auth-deps";
import { isDeployedRuntime } from "./lib/deployed-runtime";
import { isFeatureEnabled } from "./lib/feature-flags";
import { logger } from "./lib/logger";
import { RATE_LIMITS } from "./lib/rate-limits-config";
import { getRequestId, requestContextMiddleware } from "./lib/request-context";
import { createTrustProxyFn } from "./lib/trusted-proxies";
import { errorHandler } from "./middlewares/errorHandler";
import {
  requireCsrfOnAdminMutations,
  requireCsrfWhenSessionOnShopMutations,
} from "./middlewares/csrf";
import { adminMutationLooseLimit } from "./middlewares/rate-limit";
import { securityHeaders } from "./middlewares/securityHeaders";
import { stripeWebhookHandler } from "./lib/stripe/webhook-handler";
import faxWebhooksRouter from "./routes/fax/webhooks";

// Register the audit lib's request-id bridge once at import time so
// any logAudit() call from inside an HTTP request automatically
// inherits the same id pino-http put on the access log. Worker jobs
// and CLI scripts run outside the request scope; the resolver
// returns null there and audit rows skip the field.
registerAuditRequestIdResolver(getRequestId);

// Resolve consolidated env aliases (PUBLIC_BASE_URL → the five
// *_PUBLIC_BASE_URL vars + CORS allow-list; OPS_EMAIL → the operational
// recipient inboxes; TWILIO_PHONE_NUMBER → the retired voice-number
// alias) BEFORE the CORS allow-list IIFE below reads them. Backfill
// only — an explicitly-set specific var always wins. Idempotent.
applyEnvAliases();

const app: Express = express();

// We're behind Railway's reverse proxy. Without trust proxy, every request
// looks like it came from 127.0.0.1, which breaks rate limiting and
// audit-log IP capture.
//
// The custom domain adds Cloudflare as a SECOND hop in front of
// Railway, so the historical `trust proxy = 1` resolved req.ip to the
// Cloudflare colo IP for all custom-domain traffic — every IP-keyed
// limiter bucketed those visitors together (app-review 2026-06-10,
// P1-5). The predicate trusts hop 0 unconditionally (exactly the old
// behavior) plus Cloudflare's published ranges at any hop, so
// Cloudflare-routed requests resolve to the real client while direct
// Railway traffic and spoof attempts behave exactly as before. See
// lib/trusted-proxies.ts for the case-by-case safety argument.
app.set("trust proxy", createTrustProxyFn());

// Security headers — mounted FIRST so every response (including the
// Stripe webhook below, every CORS preflight, and every error handler
// response) carries them. See middlewares/securityHeaders.ts for the
// header set + per-header rationale.
app.use(securityHeaders);

// gzip/brotli response compression. Admin list + dashboard endpoints
// return large, highly-compressible JSON (claims pipelines, customer
// rollups, funnel/analytics payloads); compressing them is a pure
// egress + latency win on every response. `compression` only kicks in
// above its ~1KB default threshold, so tiny responses (health checks,
// the Stripe webhook ACK) are left untouched. A client may opt out per
// response with the `x-no-compression` header. Mounted right after the
// security headers so it wraps every downstream router, including the
// error-handler envelope.
app.use(compression());

// CORS allowlist resolution, in priority order:
//   1. RESUPPLY_ALLOWED_ORIGINS — explicit comma-separated list. Set this
//      to a custom domain or any extra origin that fronts the API.
//   2. RAILWAY_PUBLIC_DOMAIN — auto-populated by Railway with the
//      canonical *.up.railway.app host (or the bound custom domain). On
//      a single-service Railway deploy this alone is enough; we wrap it
//      in https:// to match the platform's edge-terminated TLS.
//   3. Dev fallback (non-production only) — localhost ports covering the
//      Vite dev server (5173), the API itself (3000), and common
//      alternatives (8080) so local development works without extra config.
//
// Production fails CLOSED: if NODE_ENV=production and BOTH
// RESUPPLY_ALLOWED_ORIGINS and RAILWAY_PUBLIC_DOMAIN are missing, the
// process exits at boot rather than silently inheriting the dev
// allowlist. That would expose the admin API to unintended origins, and
// the risk grows as soon as PHI-touching endpoints land — catching it
// at boot is cheaper than catching it after a leak.
const allowedOrigins = (() => {
  const explicit = (process.env.RESUPPLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const railwayHost = (process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  const fromRailway = railwayHost ? [`https://${railwayHost}`] : [];

  // De-dupe so a custom domain present in both lists doesn't appear twice.
  const merged = Array.from(new Set([...explicit, ...fromRailway]));
  if (merged.length > 0) return merged;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to start: in production at least one of " +
        "RESUPPLY_ALLOWED_ORIGINS or RAILWAY_PUBLIC_DOMAIN must be set " +
        "so the CORS allowlist is bound to vetted hostnames. Both are empty.",
    );
  }

  return [
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
  ];
})();

// `credentials: true` is required for the in-house auth path —
// the dashboard sends the `pf_session` cookie cross-origin, and
// browsers strip Set-Cookie / Cookie when credentials aren't
// allowed. The exact-match Origin allowlist above is what makes
// this safe (browsers refuse `Access-Control-Allow-Origin: *`
// when credentials are enabled, so every allowed origin is
// vetted hostname-by-hostname).
//
// A disallowed Origin must be rejected with `cb(null, false)` — NEVER an
// Error. `cb(new Error(...))` routes the request into the Express error
// handler, turning the response into a 500 for EVERY request that carries
// an unlisted Origin header — including same-origin ones: Vite emits
// `<script type="module" crossorigin>`, so the SPA's own asset fetches
// always send `Origin: https://<host>`. When the site is served from a
// host that isn't in the allowlist (e.g. the *.up.railway.app domain
// after a custom domain takes over RAILWAY_PUBLIC_DOMAIN), every script,
// stylesheet, and font 500s and the whole app dies at the error boundary.
// `cb(null, false)` simply omits the CORS response headers: the browser
// still blocks cross-origin reads (that's CORS working as designed), and
// same-origin requests — which never needed CORS approval — keep working
// no matter which hostname fronts the process.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  }),
);

// Request-ID propagation:
//   * Honor an inbound `X-Request-Id` (or `X-Correlation-Id`) header
//     when it's a sensible UUID-shaped string. That lets a caller
//     (load balancer, frontend with sentry, another service) hand us
//     a trace id and have it stitch into our pino lines plus our
//     errorHandler's JSON envelope.
//   * Generate a fresh UUIDv4 when no inbound header is present, so
//     every request still has a stable correlation key.
//   * Echo the resolved id back as `X-Request-Id` so a customer
//     hitting a 500 can read the id from the response and we can
//     find the matching server log without a timestamp dance.
//
// We sanitize the inbound header so a forged or unbounded
// `X-Request-Id` from the public internet can't blow up log
// dashboards or smuggle log-injection sequences. The allow-list is
// intentionally narrow (UUID-ish) — anything else is silently
// replaced with a server-generated id.
const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_FALLBACK_HEADER = "x-correlation-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const fromHeader =
        req.headers[REQUEST_ID_HEADER] ??
        req.headers[REQUEST_ID_FALLBACK_HEADER];
      const candidate = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
      const id =
        typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate)
          ? candidate
          : randomUUID();
      // Echo on the response so the client has a stable handle on
      // this request even when the body is the generic 500 envelope.
      res.setHeader("X-Request-Id", id);
      return id;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          // Drop query strings from logs — they may carry PHI in the
          // future (patient lookup) and we'd rather opt-in than leak.
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// Bind every downstream callback in this request's scope to a
// RequestContext carrying pino-http's req.id. Mounted AFTER pinoHttp
// (which sets req.id) so the AsyncLocalStorage scope wraps everything
// downstream — route handlers, helpers, deferred work via await.
// `lib/logger.ts`'s mixin reads from this context to attach
// `requestId` to every line; `@workspace/resupply-audit` uses the
// resolver registered above to add `_request_id` to audit row
// metadata. See `lib/request-context.ts` for the full rationale.
app.use(requestContextMiddleware);

// Stripe webhook is registered BEFORE express.json() because Stripe's
// signature verification is computed over the exact bytes Stripe sent
// — express.json() would mutate `req.body` to a parsed object that we
// can't re-serialize byte-identically. Mounting it directly on `app`
// (rather than inside the /resupply-api router tree) keeps the body
// parser order honest no matter how the router is reorganized later.
//
// Rate limit is a pre-verification DoS shield; Stripe's HMAC is the
// real gate. Built with express-rate-limit so CodeQL recognises it.
const stripeWebhookLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.stripe_webhook.windowMs,
  limit: RATE_LIMITS.stripe_webhook.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});
app.post(
  "/resupply-api/stripe/webhook",
  stripeWebhookLimiter,
  express.raw({ type: "application/json", limit: "256kb" }),
  stripeWebhookHandler,
);

// Telnyx fax webhooks (inbound fax.received + outbound delivery status)
// are registered BEFORE express.json() for the same reason as Stripe:
// Telnyx's Ed25519 signature is verified over the EXACT raw body bytes,
// so the route needs the unparsed Buffer. The requireTelnyxSignature
// middleware inside the router verifies, then parses the JSON for the
// handlers. The GET /fax/document/:token route (no body) stays in the
// main /resupply-api router tree. express.raw is a no-op for the GET
// document requests that also match this path prefix, so they fall
// through to the main router unharmed.
app.use(
  "/resupply-api/fax",
  express.raw({ type: "application/json", limit: "256kb" }),
  faxWebhooksRouter,
);

// SendGrid Event Webhook + vendor integration webhooks verify an
// ECDSA/HMAC signature over the EXACT raw body bytes, same as Stripe
// and fax above. Their routers register express.raw() locally, but
// they are mounted inside the /resupply-api tree — AFTER the global
// express.json() below, which would consume the stream first and turn
// req.body into a parsed object (the router-level raw() then no-ops).
// That shipped as "every SendGrid event 400s in production"
// (docs/app-review-2026-06-10.md P0-2). Capture the raw Buffer here,
// BEFORE the global parser; the router-level raw() and the global
// json() both skip an already-read body, so req.body stays a Buffer
// all the way to the signature middleware.
// Pre-verification DoS shield for the SendGrid Event Webhook.
// Mirrors the Stripe and integration-webhook limiters above.
const sendgridEventsLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.sendgrid_events.windowMs,
  limit: RATE_LIMITS.sendgrid_events.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});
app.use("/resupply-api/email/sendgrid-events", sendgridEventsLimiter);
app.use(
  "/resupply-api/email/sendgrid-events",
  express.raw({ type: "application/json", limit: "1mb" }),
);
app.use(
  "/resupply-api/integrations/webhooks",
  express.raw({ type: "application/json", limit: "1mb" }),
);

// The patient-packet signing endpoint can carry a drawn-signature PNG
// data URL, which exceeds the default 100 KB body cap. Parse it with a
// larger limit BEFORE the global parser; once parsed, express.json
// below is a no-op for this request.
app.use("/api/patient-packets/sign", express.json({ limit: "1mb" }));

// The CSR-order sign endpoint carries the same drawn-signature PNG
// data URL — same dedicated 1 MB parser, same reasoning as above.
app.use("/api/csr-orders/sign", express.json({ limit: "1mb" }));

// The provider-portal sign route can carry the same drawn-signature PNG
// data URL — same dedicated 1 MB parser, same reasoning as above.
app.use("/api/provider/queue", express.json({ limit: "1mb" }));

// The PacWare patient-roster import POSTs a whole report CSV as JSON
// ({ csv: "..." }), which exceeds the default 100 KB cap. Parse it with a
// larger limit BEFORE the global parser (the route + Zod also cap the
// payload). Once parsed, express.json below is a no-op for this request.
app.use("/resupply-api/admin/pacware/import", express.json({ limit: "12mb" }));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// In-house /auth/* routes. The router is unconditionally mounted;
// any required-env misconfig throws here so it surfaces at boot
// rather than at the first sign-in attempt.
const authDeps = getAuthDeps();
app.use(
  "/resupply-api/auth",
  makeAuthRouter(authDeps, {
    productName: "PennPaps",
    signatureName: "Penn Home Medical Supply",
    // Admin SPA pages live under /admin/{reset-password,verify-email}
    // — emit links that land there instead of on the customer pages.
    uiPathPrefix: "/admin",
  }),
);
logger.info(
  { event: "auth_in_house_mounted" },
  "in-house auth routes mounted at /resupply-api/auth",
);

// Second mount of the same auth router under /api/auth, used by the
// patient-facing storefront (cpap-fitter). It shares the same
// `pf_session` cookie + `auth.users` table as the dashboard mount
// above — sign in once on either surface, the session works on the
// other. The only difference vs. the dashboard mount is
// `allowSignUp: true`: the cash-pay storefront accepts customer
// sign-ups (default role `customer`), while the staff dashboard
// must remain invite-only (`allowSignUp: false`). All other deps
// (DB pool, audit, email, customerIdResolver) are reused
// from `getAuthDeps()` so we never have two divergent code paths.
const storefrontAuthDeps: AuthDeps = { ...authDeps, allowSignUp: true };
app.use(
  "/api/auth",
  makeAuthRouter(storefrontAuthDeps, {
    productName: "PennPaps",
    signatureName: "Penn Home Medical Supply",
  }),
);
logger.info(
  { event: "auth_in_house_storefront_mounted" },
  "in-house auth routes mounted at /api/auth (storefront, allowSignUp=true)",
);

// Third mount of the same auth router for the provider e-signature
// portal, at /api/provider/auth. Reuses the shared AuthDeps — crucially
// including the UNIFIED MFA probe (lib/auth-deps.ts), so an enrolled
// provider is challenged for a TOTP code here exactly as on the other
// mounts. allowSignUp stays false (providers are invited by staff);
// password-reset / verify-email links land on the storefront pages
// (uiPathPrefix unset) which work for any auth.users row. Mounted
// BEFORE the provider data router below so /api/provider/auth/* resolves
// to the auth handlers.
const providerAuthDeps: AuthDeps = { ...authDeps, allowSignUp: false };
// NOTE: no blanket feature-flag gate in front of this mount. The
// staged-rollout design (documented on providerPortalFeatureGate
// below) keeps the AUTH surface reachable while the flag is OFF so
// invited providers can sign in / enroll MFA before launch — only the
// queue/sign/decline DATA surface stays dark. An earlier blanket
// `app.use("/api/provider", flagGate)` here 404'd the auth router too,
// making the gate's auth exemption dead code and blocking pre-launch
// provider sign-in.
app.use(
  "/api/provider/auth",
  makeAuthRouter(providerAuthDeps, {
    productName: "PennPaps Provider Portal",
    signatureName: "Penn Home Medical Supply",
  }),
);
logger.info(
  { event: "auth_in_house_provider_mounted" },
  "in-house auth routes mounted at /api/provider/auth (provider portal)",
);

// Provider e-signature portal data routes (/api/provider/*). Mounted at
// the app root because the route files carry their own /api/provider/*
// prefix; mounted AFTER the provider /auth router so the auth endpoints
// win. Each route gates itself via requireProvider (+ MFA for PHI
// routes); the provider tree is NOT covered by the app-level admin/shop
// CSRF gates, so requireProvider enforces CSRF on its own mutations.
//
// Runtime gate: fail closed when the feature flag is OFF. Auth routes
// remain mounted so providers can still sign in during staged rollout,
// but the queue/sign/decline data surface stays dark.
const providerPortalFeatureGate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!req.path.startsWith("/api/provider")) {
    next();
    return;
  }
  if (
    req.path === "/api/provider/auth" ||
    req.path.startsWith("/api/provider/auth/")
  ) {
    next();
    return;
  }
  if (!(await isFeatureEnabled("provider.portal_enabled"))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};
app.use(providerPortalFeatureGate, providerPortalRouter);
logger.info(
  { event: "provider_portal_mounted" },
  "provider e-signature portal routes mounted at /api/provider",
);

// Storefront-specific rate limits (lifted from the deleted
// `api-server` artifact). Orders cost Penn an email + a fulfillment
// workflow per request — throttle hard. Usage events are anonymous
// telemetry — looser limit. Both are keyed by IP via `ipKeyGenerator`
// for IPv6-safe normalisation. `app.set("trust proxy", 1)` above is
// what makes the IP key honest behind Railway's reverse proxy.
const storefrontOrderLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.storefront_orders.windowMs,
  limit: RATE_LIMITS.storefront_orders.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: {
    error:
      "Too many order attempts from this network. Please wait a few minutes and try again, or call Penn Home Medical Supply directly.",
  },
});
app.use("/api/orders", storefrontOrderLimiter);

const storefrontUsageEventLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.storefront_usage_events.windowMs,
  limit: RATE_LIMITS.storefront_usage_events.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "Too many tracking events" },
});
app.use("/api/usage-events", storefrontUsageEventLimiter);

// Chat is a public, unauthenticated LLM gateway — every accepted
// request burns OpenAI tokens. Throttle hard per IP so a buggy client
// or an abusive visitor can't run up the bill or starve other users.
const storefrontChatLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.storefront_chat.windowMs,
  limit: RATE_LIMITS.storefront_chat.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: {
    reply:
      "You're sending messages too quickly. Please wait a minute and try again, or call (814) 471-0627 for immediate help.",
    rateLimited: true,
  },
});
app.use("/api/chat", storefrontChatLimiter);

// /api/recommend is the one hot public POST left uncapped: no token
// cost or PHI, but it runs the full mask-scoring engine on the single
// Node process per call, so an unthrottled flood is event-loop CPU
// pressure. Generous per-IP budget — a real fitter session recomputes
// only a handful of times.
const storefrontRecommendLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.storefront_recommend.windowMs,
  limit: RATE_LIMITS.storefront_recommend.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: {
    error:
      "Too many recommendation requests from this network. Please wait a moment and try again.",
  },
});
app.use("/api/recommend", storefrontRecommendLimiter);

// Reminder subscription + manage routes have different abuse shapes,
// so they get separate limiters with different keys + budgets:
//
//  - /api/reminders (signup): per-IP, tight. Every accepted request
//    inserts a row AND sends an email. Even legitimate signups should
//    be one or two per IP per window; abuse spam is the failure mode.
//
//  - /api/reminders/manage*: per-token, generous. The manage token
//    is a 64-char random capability secret, scoped to one
//    subscription. Keying on the token (not the IP) means a patient
//    behind shared NAT — mobile carrier CG-NAT, corporate proxies,
//    a support agent proxying multiple customers — can edit their
//    own reminder schedule without colliding with strangers' quota.
//    Falls back to IP keying when the token is absent/malformed so
//    a bypass attempt can't disable the limiter entirely.
const TOKEN_RE = /^[0-9a-f]{64}$/;
const reminderManageLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.reminder_manage.windowMs,
  limit: RATE_LIMITS.reminder_manage.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const token = req.query?.token;
    if (typeof token === "string" && TOKEN_RE.test(token)) {
      return `reminder-token:${token}`;
    }
    return ipKeyGenerator(req.ip ?? "0.0.0.0");
  },
  message: {
    error:
      "Too many requests for this reminder subscription. Please wait a few minutes and try again.",
  },
});
const reminderSignupLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.reminder_signup.windowMs,
  limit: RATE_LIMITS.reminder_signup.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: {
    error:
      "Too many reminder signup attempts from this network. Please wait a few minutes and try again.",
  },
});
// Dispatch on the sub-path so manage routes don't double-debit
// against the tight signup budget. `req.path` here is relative to
// the mount point (`/api/reminders`), so `/manage` and
// `/manage/unsubscribe` both match the prefix.
app.use("/api/reminders", (req: Request, res, next) => {
  if (req.path.startsWith("/manage")) {
    return reminderManageLimiter(req, res, next);
  }
  return reminderSignupLimiter(req, res, next);
});

// POST /api/newsletter/subscribe — anonymous marketing signup. Same
// drive-by form-spam abuse shape as reminder signup: tight per-IP cap.
const newsletterSubscribeLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.newsletter_subscribe.windowMs,
  limit: RATE_LIMITS.newsletter_subscribe.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: {
    error:
      "Too many newsletter signup attempts from this network. Please wait a few minutes and try again.",
  },
});
app.use("/api/newsletter", newsletterSubscribeLimiter);

// Defense-in-depth: a single CSRF gate covering every admin-tree
// mutation on both mount prefixes. Pass-through for safe methods and
// non-admin paths; enforces double-submit (`pf_csrf` cookie ⇄
// `X-PF-CSRF` header) on POST/PATCH/PUT/DELETE under `/api/admin/*`
// or `/resupply-api/admin/*`. The admin SPA already attaches the
// header on every state-changing fetch, so this is a server-only
// addition. Per-router `requireCsrf` calls (e.g. admin-users) remain
// — double-checking is harmless and keeps the per-route contracts
// self-documenting.
app.use(requireCsrfOnAdminMutations);

// Same posture for the shop tree (`/api/shop/*` and
// `/resupply-api/shop/*`). Anonymous traffic (guest checkout, public
// product browse) passes through; signed-in customers must carry the
// `X-PF-CSRF` double-submit header. Closes the gap surfaced by the
// 2026-05-28 review: state-changing routes like `/shop/checkout`,
// `/shop/me/quick-checkout`, `/shop/me/cart-snapshot`, and the rest
// of `/shop/me/*` accept cookie-based session auth but had no CSRF
// gate, leaving signed-in customers exposed to cross-origin forgery
// on every mutation.
app.use(requireCsrfWhenSessionOnShopMutations);

// Defense-in-depth IP-keyed loose rate limit on admin-tree
// mutations. Catches the gap surfaced by docs/app-review-2026-05-13.md
// P0.7 — only ~12 of ~89 admin route files had per-route limiters.
// Per-route limiters that key by adminUserId (csr-compliance-alerts,
// customer-followups, mfa, etc.) keep their tighter, action-specific
// budgets and fire AFTER `requireAdmin`; this gate sits in front of
// them as a generous IP-based safety net.
app.use(adminMutationLooseLimit());

// Routes are mounted under /resupply-api. Phase 0 ships
// /resupply-api/healthz, /resupply-api/readyz, and the admin smoke
// endpoint /resupply-api/me; richer endpoints land in later phases.
app.use("/resupply-api", router);

// Storefront routes (lifted in from the deleted `api-server`
// artifact). Mounted under /api so the cpap-fitter SPA's existing
// fetch calls — `/api/orders`, `/api/recommend`, `/api/admin/*`,
// `/api/usage-events`, `/api/reminders`, `/api/healthz` — keep
// working unchanged. Both `/api` and `/resupply-api` are served by
// this same Express process on Railway.
app.use("/api", storefrontRouter);

// Serve the cpap-fitter SPA from this same Express process so a
// single Railway service hosts both the API and the customer/admin
// UI (matches the "one customer-facing site" topology documented in
// README.md / CLAUDE.md). Without this block, every direct URL on
// the deploy host falls through to a 404 — including the admin sign-
// in form's POST, which the SPA renders as "Not found." (see
// lib/resupply-auth-react/src/client.ts:defaultMessageForStatus).
//
// Path resolution, in preference order:
//   1. `<this module's dir>/public` — the deploy build EMBEDS the SPA
//      inside this artifact's own dist (railway.json buildCommand runs
//      scripts/embed-spa.mjs after the workspace builds). The runtime
//      image is guaranteed to keep resupply-api's dist (the start
//      command runs from it), so the embedded copy makes SPA serving
//      independent of any other workspace's output surviving image
//      assembly.
//   2. `../../cpap-fitter/dist/public` — the sibling workspace output
//      (local builds / historical layout). From the bundled
//      `artifacts/resupply-api/dist/index.mjs` AND from src in dev,
//      two parent dirs up reaches `artifacts/`.
//
// We guard on index.html presence so a dev session running only the API
// (with Vite serving the SPA on a separate port) skips the wiring
// gracefully — the API still works, the SPA just isn't co-served.
const SPA_DIST_CANDIDATES = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public"),
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../cpap-fitter/dist/public",
  ),
];
const SPA_DIST =
  SPA_DIST_CANDIDATES.find((dir) => existsSync(path.join(dir, "index.html"))) ??
  SPA_DIST_CANDIDATES[1]!;
const SPA_INDEX_HTML = path.join(SPA_DIST, "index.html");

if (existsSync(SPA_INDEX_HTML)) {
  // Vite emits content-hashed filenames under `assets/` (e.g.
  // `index-DJvwPG8s.js`): the bytes behind a given name can never change,
  // so serve those `immutable` with a 1-year max-age. That skips even the
  // ETag/304 *revalidation* round-trip on repeat visits — a real win on
  // high-latency mobile and it lets Railway's edge / any CDN hold them.
  // Files NOT under `assets/` (the vendored, fixed-NAME MediaPipe model and
  // the favicons) keep the default ETag/304 so a new build is picked up
  // immediately instead of being pinned for a year.
  // `index: false` forces the explicit history-fallback handler below to be
  // the only path that serves index.html, so a GET to `/` and a GET to
  // `/admin/sign-in` go through the same code path and pick up the same
  // (no-store) Cache-Control header.
  app.use(
    express.static(SPA_DIST, {
      index: false,
      fallthrough: true,
      setHeaders: (res, filePath) => {
        const rel = path.relative(SPA_DIST, filePath);
        if (rel === "assets" || rel.startsWith(`assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // SPA history fallback. Any unmatched GET that accepts HTML and
  // isn't under /api or /resupply-api (those return their own
  // 404 — we don't want a missing API route to silently 200 with
  // HTML and confuse fetch callers) falls back to index.html so
  // Wouter can route it client-side. `no-store` on the HTML keeps
  // a CDN from pinning a stale build after the hashed asset
  // filenames roll forward.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const p = req.path;
    if (
      p === "/api" ||
      p === "/resupply-api" ||
      p.startsWith("/api/") ||
      p.startsWith("/resupply-api/")
    ) {
      return next();
    }
    if (p.startsWith("/assets/")) return next();
    if (path.basename(p).includes(".")) return next();
    const acceptHeader = req.headers.accept;
    if (
      typeof acceptHeader !== "string" ||
      !acceptHeader.toLowerCase().includes("text/html")
    ) {
      return next();
    }
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(SPA_INDEX_HTML);
  });

  // R1 safety net (docs/railway-hosting-review-2026-05-29.md): the face-scan
  // model is vendored into the SPA build at
  // `mediapipe/models/face_landmarker.task` by cpap-fitter's prebuild step.
  // If it's absent here, the build shipped without it and the face-capture
  // flow will be broken at runtime — surface that loudly at boot rather than
  // letting customers discover it. Non-fatal: every other surface works, so
  // we log instead of refusing to serve.
  const FACE_MODEL = path.join(
    SPA_DIST,
    "mediapipe",
    "models",
    "face_landmarker.task",
  );
  if (!existsSync(FACE_MODEL)) {
    logger.error(
      { event: "face_model_missing", face_model: FACE_MODEL },
      "face_landmarker.task missing from the SPA build — face-scan will be unavailable; rebuild with the model present (setup-mediapipe) or provide it out-of-band",
    );
  }

  logger.info(
    { event: "spa_mounted", spa_dist: SPA_DIST },
    "serving cpap-fitter SPA + history fallback from this process",
  );
} else {
  // Deployed runtime (NODE_ENV=production OR any Railway-injected
  // marker): refuse to start. Crashing before the listener binds fails
  // the deploy's health check, so Railway keeps the previous (working)
  // release serving. Keying this on NODE_ENV alone left the guard
  // unable to fire on Railway at all — Railway doesn't inject NODE_ENV,
  // so a dist-less image (if one were ever built) would sail past the
  // deliberately dependency-free liveness probe and go live.
  if (isDeployedRuntime(process.env)) {
    logger.error(
      { event: "spa_dist_missing", spa_dist: SPA_DIST },
      "cpap-fitter dist not found in a deployed runtime — refusing to start",
    );
    throw new Error(
      "Refusing to start: cpap-fitter dist/public/index.html missing",
    );
  }
  logger.warn(
    { event: "spa_dist_missing", spa_dist: SPA_DIST },
    "cpap-fitter dist not found — SPA will not be co-served from this process",
  );
}

// Top-level error handler — MUST be the last middleware mounted on
// the app. Catches any error a route handler throws (or passes via
// next(err)), emits ONE structured log line, and returns a generic
// JSON envelope so we never leak stack traces or PHI-adjacent
// identifiers in error responses. See middlewares/errorHandler.ts.
app.use(errorHandler);

export default app;
