// /admin/analytics/resupply-funnel — funnel rollup across episodes
// over a window. Counts each terminal/state for episodes whose
// due_at falls inside the window.
//
//   GET /admin/analytics/resupply-funnel?from=ISO&to=ISO
//
// Returns:
//   total                  total episodes whose due_at is in [from, to]
//   byStatus               { outreach_pending, awaiting_response, ... }
//   confirmRate            confirmed / (confirmed + declined + expired)
//   fulfillmentRate        fulfilled / confirmed

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const STATUSES = [
  "outreach_pending",
  "awaiting_response",
  "confirmed",
  "declined",
  "expired",
  "fulfilled",
  "canceled",
] as const;
type EpisodeStatus = (typeof STATUSES)[number];

const querySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

router.get(
  "/admin/analytics/resupply-funnel",
  // Episode-stage rollup analytics. `reports.read` matches the
  // rest of the analytics surface.
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const to = parsed.data.to ?? new Date().toISOString();
    const from =
      parsed.data.from ??
      new Date(Date.now() - 30 * 86400_000).toISOString();
    const supabase = getSupabaseServiceRoleClient();

    // One head-count query per status. Cheaper and safer than
    // pulling every row into memory for a busy DME.
    const counts: Partial<Record<EpisodeStatus, number>> = {};
    for (const s of STATUSES) {
      const { count, error } = await supabase
        .schema("resupply")
        .from("episodes")
        .select("*", { count: "exact", head: true })
        .eq("status", s)
        .gte("due_at", from)
        .lte("due_at", to);
      if (error) throw error;
      counts[s] = count ?? 0;
    }
    const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
    const confirmDenom =
      (counts.confirmed ?? 0) +
      (counts.declined ?? 0) +
      (counts.expired ?? 0);
    const confirmRate =
      confirmDenom > 0 ? (counts.confirmed ?? 0) / confirmDenom : null;
    const fulfillmentRate =
      (counts.confirmed ?? 0) > 0
        ? (counts.fulfilled ?? 0) / (counts.confirmed ?? 0)
        : null;

    res.json({
      window: { from, to },
      total,
      byStatus: counts,
      confirmRate,
      fulfillmentRate,
    });
  },
);

export default router;
