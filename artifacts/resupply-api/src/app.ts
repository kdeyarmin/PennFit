import { randomUUID } from "node:crypto";

import express, { type Express, type Request } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { makeAuthRouter, type AuthDeps } from "@workspace/resupply-auth";
import { registerAuditRequestIdResolver } from "@workspace/resupply-audit";
import router from "./routes";
import storefrontRouter from "./routes/storefront";
import { getAuthDeps } from "./lib/auth-deps";
import { logger } from "./lib/logger";
import { RATE_LIMITS } from "./lib/rate-limits-config";
import {
  getRequestId,
  requestContextMiddleware,
} from "./lib/request-context";
import { errorHandler } from "./middlewares/errorHandler";
import { requireCsrfOnAdminMutations } from "./middlewares/csrf";
import { adminMutationLooseLimit } from "./middlewares/rate-limit";
import { securityHeaders } from "./middlewares/securityHeaders";
import { stripeWebhookHandler } from "./lib/stripe/webhook-handler";

// Register the audit lib's request-id bridge once at import time so
// any logAudit() call from inside an HTTP request automatically
// inherits the same id pino-http put on the access log. Worker jobs
// and CLI scripts run outside the request scope; the resolver
// returns null there and audit rows skip the field.
registerAuditRequestIdResolver(getRequestId);

const app: Express = express();

// We're behind Replit's reverse proxy. Without trust proxy, every request
// looks like it came from 127.0.0.1, which breaks rate limiting and
// audit-log IP capture.
app.set("trust proxy", 1);

// Security headers — mounted FIRST so every response (including the
// Stripe webhook below, every CORS preflight, and every error handler
// response) carries them. See middlewares/securityHeaders.ts for the
// header set + per-header rationale.
app.use(securityHeaders);

// CORS allowlist resolution, in priority order:
//   1. RESUPPLY_ALLOWED_ORIGINS — explicit comma-separated list. Use this
//      for custom domains or multi-tenant deployments where the runtime
//      hostnames don't match the public-facing URL (e.g. fronted by a
//      CDN or vanity domain).
//   2. REPLIT_DOMAINS (production only) — Replit's runtime sets this to
//      the exact hostnames the deployment is serving on. It is NOT
//      attacker-controlled (no inbound HTTP can mutate it), so falling
//      back to it preserves the same safety property as the explicit
//      allowlist while removing a foot-gun where every deploy needs a
//      manual env var.
//   3. Dev fallback (non-production only) — Replit dev domain +
//      localhost ports so preview iframes and curl can hit the API.
//
// Production fails CLOSED: if NODE_ENV=production and BOTH the explicit
// env var and REPLIT_DOMAINS are missing or empty, the process exits at
// boot rather than silently inheriting the dev allowlist. That would
// expose the admin API to unintended origins, and the risk grows as
// soon as PHI-touching endpoints land — catching it at boot is cheaper
// than catching it after a leak.
const allowedOrigins = (() => {
  const fromEnv = (process.env.RESUPPLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;

  if (process.env.NODE_ENV === "production") {
    // REPLIT_DOMAINS is comma-separated and bare-host (no scheme).
    // Production deployments are always HTTPS, so prepend `https://`.
    const fromReplit = (process.env.REPLIT_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => `https://${d}`);
    if (fromReplit.length > 0) {
      logger.info(
        { origins: fromReplit, source: "REPLIT_DOMAINS" },
        "CORS allowlist derived from REPLIT_DOMAINS",
      );
      return fromReplit;
    }
    throw new Error(
      "Refusing to start: in production we require either " +
        "RESUPPLY_ALLOWED_ORIGINS or REPLIT_DOMAINS to be set so the " +
        "CORS allowlist is bound to vetted hostnames. Both are empty.",
    );
  }

  const dev: string[] = [];
  if (process.env.REPLIT_DEV_DOMAIN) {
    dev.push(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  dev.push(
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:80",
  );
  return dev;
})();

// `credentials: true` is required for the in-house auth path —
// the dashboard sends the `pf_session` cookie cross-origin, and
// browsers strip Set-Cookie / Cookie when credentials aren't
// allowed. The exact-match Origin allowlist above is what makes
// this safe (browsers refuse `Access-Control-Allow-Origin: *`
// when credentials are enabled, so every allowed origin is
// vetted hostname-by-hostname).
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS policy`));
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
app.post(
  "/resupply-api/stripe/webhook",
  express.raw({ type: "application/json", limit: "256kb" }),
  stripeWebhookHandler,
);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// In-house /auth/* routes. The router is unconditionally mounted;
// any required-env misconfig throws here so it surfaces at boot
// rather than at the first sign-in attempt.
const authDeps = getAuthDeps();
app.use(
  "/resupply-api/auth",
  makeAuthRouter(authDeps, {
    productName: "Resupply",
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
    productName: "Penn Home Medical Supply",
  }),
);
logger.info(
  { event: "auth_in_house_storefront_mounted" },
  "in-house auth routes mounted at /api/auth (storefront, allowSignUp=true)",
);

// Storefront-specific rate limits (lifted from the deleted
// `api-server` artifact). Orders cost Penn an email + a fulfillment
// workflow per request — throttle hard. Usage events are anonymous
// telemetry — looser limit. Both are keyed by IP via `ipKeyGenerator`
// for IPv6-safe normalisation. `app.set("trust proxy", 1)` above is
// what makes the IP key honest behind Replit's reverse proxy.
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
app.use(
  "/api/reminders",
  (req: Request, res, next) => {
    if (req.path.startsWith("/manage")) {
      return reminderManageLimiter(req, res, next);
    }
    return reminderSignupLimiter(req, res, next);
  },
);

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

// Defense-in-depth IP-keyed loose rate limit on admin-tree
// mutations. Catches the gap surfaced by docs/app-review-2026-05-13.md
// P0.7 — only ~12 of ~89 admin route files had per-route limiters.
// Per-route limiters that key by adminUserId (csr-compliance-alerts,
// customer-followups, mfa, etc.) keep their tighter, action-specific
// budgets and fire AFTER `requireAdmin`; this gate sits in front of
// them as a generous IP-based safety net.
app.use(adminMutationLooseLimit());

// Routes are mounted under /resupply-api (matches the artifact.toml path
// list). Phase 0 ships /resupply-api/healthz, /resupply-api/readyz,
// and the admin smoke endpoint /resupply-api/me; richer endpoints
// land in later phases.
app.use("/resupply-api", router);

// Storefront routes (lifted in from the deleted `api-server`
// artifact). Mounted under /api so the cpap-fitter SPA's existing
// fetch calls — `/api/orders`, `/api/recommend`, `/api/admin/*`,
// `/api/usage-events`, `/api/reminders`, `/api/healthz` — keep
// working unchanged. Both `/api` and `/resupply-api` are advertised
// in this artifact's artifact.toml `paths` so the Replit reverse
// proxy routes both prefixes to this same Express process.
app.use("/api", storefrontRouter);

// Top-level error handler — MUST be the last middleware mounted on
// the app. Catches any error a route handler throws (or passes via
// next(err)), emits ONE structured log line, and returns a generic
// JSON envelope so we never leak stack traces or PHI-adjacent
// identifiers in error responses. See middlewares/errorHandler.ts.
app.use(errorHandler);

export default app;
