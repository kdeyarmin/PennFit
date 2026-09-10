// Therapy monitoring handlers: the Therapy Fleet + Resupply Opportunities
// pages read nested fields off their API responses without optional chaining
// (e.g. summary.byCategory.mask, summary.byKind.pressure_at_max), so the
// router's empty `{}` fallback makes them throw. These return fully-shaped
// sample data so both pages render in the demo.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoResupplyCalendar,
  demoSupplyOverview,
} from "../fixtures/resupply-calendar";
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
  route("GET", "/resupply-api/admin/resupply-calendar", (req) =>
    json(
      demoResupplyCalendar(
        req.query.get("from") ?? "",
        req.query.get("to") ?? "",
        req.query.get("overdue") === "true",
      ),
    ),
  ),
  route(
    "GET",
    "/resupply-api/admin/patients/:id/supply-overview",
    (_req, { id }) => json(demoSupplyOverview(id)),
  ),
  route("POST", "/resupply-api/admin/resupply-outreach", (req) =>
    json({
      results: (req.json<{ episodeIds: string[] }>()?.episodeIds ?? []).map(
        (episodeId) => ({
          episodeId,
          status: "queued",
          message: "Demo only: outreach simulated. No patient was contacted.",
        }),
      ),
    }),
  ),
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
  // Approving a seeded draft — without this the item-level POST falls through
  // to the generic `{ ok: true }` fallback and the success screen renders
  // undefined order reference / pay link. Return a realistic checkout result.
  route(
    "POST",
    "/resupply-api/admin/therapy-resupply/draft-orders/:id/approve",
    (_req, { id }) => {
      const ref = `CMB-DEMO-90${(String(id).match(/\d+/)?.[0] ?? "1").slice(-2)}`;
      return json({
        ok: true,
        draftId: id,
        orderRequestId: `demo-or-${id}`,
        orderReference: ref,
        link: `https://cmbreathe.com/pay/${ref.toLowerCase()}`,
        emailSent: true,
        smsSent: false,
      });
    },
  ),
  // Dismissing a seeded draft.
  route(
    "POST",
    "/resupply-api/admin/therapy-resupply/draft-orders/:id/dismiss",
    (_req, { id }) => json({ ok: true, id }),
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
