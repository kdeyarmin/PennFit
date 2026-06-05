// GET /admin/analytics/outreach-attribution?days=30&attributionWindowDays=14
// GET /admin/analytics/outreach-attribution.csv?...
//
// Closed-loop measurement (roadmap Lever 3, the attribution half): of the
// patients we proactively contacted in the window, how many placed a
// resupply order (fulfillment) within N days of that contact — split by
// outreach channel. Pairs with /admin/analytics/revenue-by-source
// (volume/revenue by channel) and the resupply funnel (episode flow).
//
// Read-only, window-bounded, in the established analytics shape (route
// reads, lib/analytics/outreach-attribution.ts reduces). No new schema.
//
// PHI: only patient_id (internal uuid) + created_at are read from each
// table — never message bodies, names, or contact details.

import { Router, type IRouter, type Response } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  aggregateOutreachAttribution,
  type OutreachContact,
  type FulfillmentEvent,
} from "../../lib/analytics/outreach-attribution";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
  attributionWindowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .default(14),
});

const READ_CAP = 50_000;

// Thrown when the window holds more rows than we read in one page, so the
// aggregate would silently miscount contacts/conversions. The route
// converts it to a clear 422 rather than returning wrong rates. (A SQL
// aggregation RPC would remove the cap entirely — scale-out follow-up.)
class AttributionWindowTooLargeError extends Error {
  constructor(readonly cap: number) {
    super("attribution_window_too_large");
    this.name = "AttributionWindowTooLargeError";
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

// Translate the window-too-large sentinel into a 422 the caller can act
// on (reduce `days`). Returns true when it handled the error.
function handleWindowTooLarge(err: unknown, res: Response): boolean {
  if (err instanceof AttributionWindowTooLargeError) {
    res.status(422).json({
      error: "window_too_large",
      message: `Too many records in this window to aggregate accurately (> ${err.cap}). Choose a shorter window.`,
    });
    return true;
  }
  return false;
}

async function loadOutreachAttribution(cutoff: string, windowDays: number) {
  const supabase = getSupabaseServiceRoleClient();

  const [convRes, clinRes, fulRes] = await Promise.all([
    // Resupply reminders = episode-linked conversations opened in window.
    supabase
      .schema("resupply")
      .from("conversations")
      .select("patient_id, created_at", { count: "exact" })
      .not("episode_id", "is", null)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(READ_CAP),
    // Clinical outreach actually sent in window.
    supabase
      .schema("resupply")
      .from("clinical_outreach_log")
      .select("patient_id, created_at", { count: "exact" })
      .eq("status", "sent")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(READ_CAP),
    // Fulfillments from window start onward (a contact can only be
    // credited a fulfillment at/after it).
    supabase
      .schema("resupply")
      .from("fulfillments")
      .select("patient_id, created_at", { count: "exact" })
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(READ_CAP),
  ]);
  if (convRes.error) throw convRes.error;
  if (clinRes.error) throw clinRes.error;
  if (fulRes.error) throw fulRes.error;

  // Fail fast rather than silently miscount: if any capped read matched
  // more rows than we pulled, the attribution would be wrong.
  if (
    (convRes.count ?? 0) > READ_CAP ||
    (clinRes.count ?? 0) > READ_CAP ||
    (fulRes.count ?? 0) > READ_CAP
  ) {
    throw new AttributionWindowTooLargeError(READ_CAP);
  }

  const toContact = (
    rows: Array<{ patient_id: string | null; created_at: string | null }>,
  ): OutreachContact[] =>
    rows
      .filter((r) => r.patient_id && r.created_at)
      .map((r) => ({
        patientId: r.patient_id as string,
        at: r.created_at as string,
      }));

  const fulfillments: FulfillmentEvent[] = (fulRes.data ?? [])
    .filter((r) => r.patient_id && r.created_at)
    .map((r) => ({
      patientId: r.patient_id as string,
      at: r.created_at as string,
    }));

  return aggregateOutreachAttribution({
    reminderContacts: toContact(convRes.data ?? []),
    clinicalContacts: toContact(clinRes.data ?? []),
    fulfillments,
    attributionWindowDays: windowDays,
  });
}

router.get(
  "/admin/analytics/outreach-attribution",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { days, attributionWindowDays } = parsed.data;
    try {
      const result = await loadOutreachAttribution(
        isoDaysAgo(days),
        attributionWindowDays,
      );
      res.json({ windowDays: days, ...result });
    } catch (err) {
      if (handleWindowTooLarge(err, res)) return;
      throw err;
    }
  },
);

router.get(
  "/admin/analytics/outreach-attribution.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { days, attributionWindowDays } = parsed.data;
    let result: Awaited<ReturnType<typeof loadOutreachAttribution>>;
    try {
      result = await loadOutreachAttribution(
        isoDaysAgo(days),
        attributionWindowDays,
      );
    } catch (err) {
      if (handleWindowTooLarge(err, res)) return;
      throw err;
    }

    const filename = `outreach-attribution-${days}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(
      "source,label,contacted_patients,converted_patients,conversion_rate\n",
    );
    const rows = [...result.bySource, result.overall];
    for (const b of rows) {
      const rate = b.conversionRate == null ? "" : b.conversionRate.toFixed(4);
      res.write(
        `${b.source},${safeCsvCell(b.label)},${b.contactedPatients},${b.convertedPatients},${rate}\n`,
      );
    }
    res.end();
  },
);

export default router;
