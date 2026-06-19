// Therapy monitoring handlers: the Therapy Fleet + Resupply Opportunities
// pages read nested fields off their API responses without optional chaining
// (e.g. summary.byCategory.mask, summary.byKind.pressure_at_max), so the
// router's empty `{}` fallback makes them throw. These return fully-shaped
// sample data so both pages render in the demo.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoResupplySummary,
  demoResupplyOpportunities,
  demoResupplyDrafts,
  demoFleetOverview,
  demoFleetTrend,
  demoFleetAlerts,
  demoFleetWorklist,
  demoClinicalInsights,
} from "../fixtures/therapy";

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
): number {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const therapyHandlers: DemoHandler[] = [
  // ── Resupply Opportunities ──────────────────────────────────────────
  route("GET", "/resupply-api/admin/therapy-resupply/summary", (req) =>
    json(demoResupplySummary(intParam(req, "dueWithinDays", 0))),
  ),
  route("GET", "/resupply-api/admin/therapy-resupply/opportunities", (req) =>
    json(
      demoResupplyOpportunities({
        dueWithinDays: intParam(req, "dueWithinDays", 0),
        category: req.query.get("category") ?? undefined,
      }),
    ),
  ),
  route("GET", "/resupply-api/admin/therapy-resupply/draft-orders", (req) =>
    json(demoResupplyDrafts(req.query.get("status") ?? "proposed")),
  ),
  // Staging drafts from the opportunities table — echo a benign result.
  route("POST", "/resupply-api/admin/therapy-resupply/draft-orders", () =>
    json({ staged: 0, skipped: 0 }),
  ),

  // ── Therapy Fleet ───────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/therapy-fleet/overview", (req) =>
    json(demoFleetOverview(intParam(req, "windowDays", 30))),
  ),
  route("GET", "/resupply-api/admin/therapy-fleet/trend", (req) =>
    json(demoFleetTrend(intParam(req, "days", 30))),
  ),
  route("GET", "/resupply-api/admin/therapy-fleet/alerts", () =>
    json(demoFleetAlerts()),
  ),
  route("GET", "/resupply-api/admin/therapy-fleet/worklist", (req) =>
    json(
      demoFleetWorklist({
        windowDays: intParam(req, "windowDays", 30),
        reason: req.query.get("reason") ?? undefined,
      }),
    ),
  ),
  route("GET", "/resupply-api/admin/therapy-fleet/clinical-insights", (req) =>
    json(demoClinicalInsights(req.query.get("kind") ?? undefined)),
  ),
];
