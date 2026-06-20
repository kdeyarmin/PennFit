import { Router, type IRouter } from "express";
import { checkReadiness, type ReadinessResult } from "../lib/readiness";
import { rateLimit } from "../middlewares/rate-limit";

const router: IRouter = Router();
const READYZ_CACHE_MS = 5_000;
const READYZ_FALLBACK_CACHE_MS = 1_000;

let cachedReadyz: { expiresAtMs: number; result: ReadinessResult } | null =
  null;
let inFlightReadyz: Promise<ReadinessResult> | null = null;

const safeNotReady: ReadinessResult = {
  status: "not_ready",
  checks: { db: "failed", queue: "failed" },
  errors: { db: "unavailable", queue: "unavailable" },
};

const readyzRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  name: "readyz",
});

async function getReadyzSnapshot(): Promise<ReadinessResult> {
  const now = Date.now();
  if (cachedReadyz && cachedReadyz.expiresAtMs > now) {
    return cachedReadyz.result;
  }
  if (inFlightReadyz) return inFlightReadyz;

  inFlightReadyz = checkReadiness()
    .then((result) => {
      cachedReadyz = {
        result,
        expiresAtMs: Date.now() + READYZ_CACHE_MS,
      };
      return result;
    })
    .catch(() => {
      cachedReadyz = {
        result: safeNotReady,
        expiresAtMs: Date.now() + READYZ_FALLBACK_CACHE_MS,
      };
      return safeNotReady;
    })
    .finally(() => {
      inFlightReadyz = null;
    });

  return inFlightReadyz;
}

export function __resetReadyzCacheForTests(): void {
  cachedReadyz = null;
  inFlightReadyz = null;
}

// Liveness only — does NOT touch the DB. The deploy gate uses this to
// decide whether the container process is up at all. If you're tempted
// to add a dependency check here, add it to /readyz instead.
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "resupply-api" });
});

// Readiness — confirms the API can actually serve traffic by probing
// every dependency admins rely on (Postgres + the pg-boss queue).
// Returns 503 on any failure so load balancers / deploy gates stop
// routing traffic until the dependency recovers. The body still
// includes per-dependency status on a 503 so an admin looking at
// the response can tell *which* dependency was unhappy without
// scraping logs. See ./lib/readiness.ts for the failure-categorization
// allowlist — we deliberately don't echo raw error messages.
//
// Public probes are cheap for the caller but not free for the app: a
// readiness check exercises PostgREST through the Supabase service-role
// client. Cache the result briefly and collapse concurrent checks so a
// burst of external probes cannot become a burst of DB dependency calls.
router.get("/readyz", readyzRateLimit, async (_req, res) => {
  const result = await getReadyzSnapshot();
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status === "ready" ? 200 : 503).json(result);
});

export default router;
