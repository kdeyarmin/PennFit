import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import { logger } from "./lib/logger";
import { stripeWebhookHandler } from "./lib/stripe/webhook-handler";

const app: Express = express();

// We're behind Replit's reverse proxy. Without trust proxy, every request
// looks like it came from 127.0.0.1, which breaks rate limiting and
// audit-log IP capture.
app.set("trust proxy", 1);

// CORS allowlist. In dev (no RESUPPLY_ALLOWED_ORIGINS set) we allow the
// Replit dev domain + localhost so the admin dashboard preview iframe
// can call the API. In production, only explicitly-listed origins
// (comma-separated env var) are allowed — admins should only access
// the dashboard from a vetted URL.
//
// Production fails CLOSED: if NODE_ENV=production and the env var is
// missing or empty, the process exits at boot rather than silently
// inheriting the dev allowlist. Misconfigured CORS in prod could
// expose the admin API to attacker-controlled origins, and that
// risk grows as soon as Phase 1 lands real PHI-touching endpoints —
// catching it at boot is cheaper than catching it after a leak.
const allowedOrigins = (() => {
  const fromEnv = (process.env.RESUPPLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "RESUPPLY_ALLOWED_ORIGINS must be set in production. Refusing to " +
        "fall back to the dev allowlist (localhost + Replit dev domain) — " +
        "that would expose the admin API to unintended origins.",
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

// Clerk session middleware — attaches auth state (`getAuth(req)`) to
// every request so downstream admin-gated routes can read it. Safe
// to mount globally: it's a no-op for unauthenticated requests, and
// the unauthenticated /healthz, /readyz probes don't read auth state
// at all. We mount it BEFORE the route tree so every nested router
// inherits it without needing per-router wiring.
app.use(clerkMiddleware());

// Routes are mounted under /resupply-api (matches the artifact.toml path
// list). Phase 0 ships /resupply-api/healthz, /resupply-api/readyz,
// and the admin smoke endpoint /resupply-api/me; richer endpoints
// land in later phases.
app.use("/resupply-api", router);

export default app;
