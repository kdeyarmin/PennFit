import express, { type Express, type Request } from "express";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import pinoHttp from "pino-http";
import { makeAuthRouter } from "@workspace/resupply-auth";
import router from "./routes";
import { getAuthDeps } from "./lib/auth-deps";
import { logger } from "./lib/logger";

const app: Express = express();

// We're behind Replit's reverse proxy. Without trust proxy, every request
// looks like it came from 127.0.0.1 and the rate limiter would group all
// users together (and refuse to start in strict mode).
app.set("trust proxy", 1);

// CORS allowlist. In dev (no PENN_ALLOWED_ORIGINS set) we allow same-origin
// + the Replit dev domain so the preview iframe can call the API. In
// production, only the explicitly-listed origins (comma-separated env var)
// can call us — this prevents arbitrary websites from posting orders into
// Penn's fulfillment inbox.
const allowedOrigins = (() => {
  const fromEnv = (process.env.PENN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  // Dev fallback: allow Replit dev domain + localhost for local testing.
  const dev: string[] = [];
  if (process.env.REPLIT_DEV_DOMAIN) {
    dev.push(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  // Replit's reverse proxy presents requests with `Origin: http://localhost`
  // (no port) when the preview iframe calls us, so include the bare-host
  // variant alongside the explicit-port forms used by direct dev servers.
  dev.push(
    "http://localhost",
    "http://localhost:80",
    "http://localhost:3000",
    "http://localhost:5173",
  );
  return dev;
})();

app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin requests (server-to-server, curl, mobile) have no Origin
      // header — allow them. Browser cross-origin requests must match the
      // allowlist exactly.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS policy`));
    },
    credentials: true,
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
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Rate limit on the order endpoint specifically. Recommendation/catalog are
// cheap and stateless, so they don't need this. Orders cost Penn an email
// + a fulfillment workflow per request, so we throttle hard:
//   - 5 attempts per 10 min per IP
//   - keyed by IP (with proxy trust set above)
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // ipKeyGenerator handles IPv6 normalization correctly.
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: {
    error:
      "Too many order attempts from this network. Please wait a few minutes and try again, or call Penn Home Medical Supply directly.",
  },
});
app.use("/api/orders", orderLimiter);

// Usage-event tracking is high-volume but anonymous — looser limit.
const usageEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "Too many tracking events" },
});
app.use("/api/usage-events", usageEventLimiter);

// In-house /api/auth/* routes. Unconditionally mounted after
// Stage 5a — a missing AUTH_PASSWORD_PEPPER throws here so the
// misconfig surfaces at boot.
const authDeps = getAuthDeps();
app.use("/api/auth", makeAuthRouter(authDeps, { productName: "PennFit" }));
logger.info(
  { event: "auth_in_house_mounted" },
  "in-house auth routes mounted at /api/auth",
);

app.use("/api", router);

export default app;
