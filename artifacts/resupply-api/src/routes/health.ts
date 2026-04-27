import { Router, type IRouter } from "express";

const router: IRouter = Router();

// Liveness only — does NOT touch the DB. The deploy gate uses this to
// decide whether the container is up. Readiness (DB reachable, migrations
// applied, vendor adapters healthy) is a separate /readyz endpoint we'll
// add when the relevant dependencies actually exist.
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "resupply-api" });
});

export default router;
