import { Router, type IRouter } from "express";
import { checkReadiness } from "../lib/readiness";

const router: IRouter = Router();

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
router.get("/readyz", async (_req, res) => {
  try {
    const result = await checkReadiness();
    res.status(result.status === "ready" ? 200 : 503).json(result);
  } catch {
    // checkReadiness() is designed to never throw — every probe is
    // wrapped in Promise.allSettled with a per-check timeout. But if a
    // future regression breaks that contract, falling through to
    // Express's default 500 handler would (a) drop the structured
    // body admins rely on, and (b) potentially leak the raw error
    // through the default error middleware. Fail closed with a safe,
    // structured 503 instead.
    res.status(503).json({
      status: "not_ready",
      checks: { db: "failed", queue: "failed" },
      errors: { db: "unavailable", queue: "unavailable" },
    });
  }
});

export default router;
