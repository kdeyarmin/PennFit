import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { makeAuthRouter } from "@workspace/resupply-auth";
import router from "./routes";
import { getAuthDepsOrNull } from "./lib/auth-deps";
import { logger } from "./lib/logger";
import { errorHandler } from "./middlewares/errorHandler";
import { securityHeaders } from "./middlewares/securityHeaders";
import { stripeWebhookHandler } from "./lib/stripe/webhook-handler";

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
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:80",
  );
  return dev;
})();

// `credentials` is intentionally OFF: the dashboard authenticates with
// `Authorization: Bearer <clerk_token>`, never cookies. Setting
// `credentials: true` would oblige us to keep an exact-match Origin
// allowlist forever (browsers refuse `Access-Control-Allow-Origin: *`
// when credentials are enabled) AND would unlock cookie-based CSRF
// attack surface that we don't actually use. Bearer tokens are
// immune to classic CSRF because the browser does not auto-attach
// them — JS code must read and send them deliberately. Leaving
// credentials off is the simpler, safer default for a Bearer-only
// API.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS policy`));
    },
  }),
);

app.use(
  pinoHttp({
    logger,
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

// session middleware — attaches auth state (`getAuth(req)`) to
// every request so downstream admin-gated routes can read it. Safe
// to mount globally: it's a no-op for unauthenticated requests, and
// the unauthenticated /healthz, /readyz probes don't read auth state
// at all. We mount it BEFORE the route tree so every nested router
// inherits it without needing per-router wiring.
app.use(clerkMiddleware());

// In-house /auth/* routes — only mounted when AUTH_PROVIDER is
// "dual" or "in_house". The default ("clerk") leaves the in-house
// path entirely off the wire so a misconfig can't accidentally
// expose it. See ADR 014 + docs/resupply/AUTH-MIGRATION-PLAN.md.
const authDeps = getAuthDepsOrNull();
if (authDeps) {
  app.use(
    "/resupply-api/auth",
    makeAuthRouter(authDeps, { productName: "Resupply" }),
  );
  logger.info(
    { event: "auth_in_house_mounted", provider: authDeps.env.provider },
    "in-house auth routes mounted at /resupply-api/auth",
  );
}

// Routes are mounted under /resupply-api (matches the artifact.toml path
// list). Phase 0 ships /resupply-api/healthz, /resupply-api/readyz,
// and the admin smoke endpoint /resupply-api/me; richer endpoints
// land in later phases.
app.use("/resupply-api", router);

// Top-level error handler — MUST be the last middleware mounted on
// the app. Catches any error a route handler throws (or passes via
// next(err)), emits ONE structured log line, and returns a generic
// JSON envelope so we never leak stack traces or PHI-adjacent
// identifiers in error responses. See middlewares/errorHandler.ts.
app.use(errorHandler);

export default app;
