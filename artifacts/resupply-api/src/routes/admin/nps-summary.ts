// /admin/nps/recent — recent NPS-response rollup for the admin
// dashboard widget.
//
// Returns the last 7 days of post-delivery NPS scores aggregated
// into:
//   * counts per band (promoter 9-10, passive 7-8, detractor 0-6)
//   * the canonical NPS score (% promoter - % detractor)
//   * a tail of recent responses with comments, for the qualitative
//     read the CSR + billing teams actually act on.
//
// All data lives on shop_order_nps_responses (migration 0127). The
// schema allows multiple rows per order; we dedup to "most recent
// rating per order" inside the rollup so a patient who clicked one
// score then changed their mind doesn't get double-counted.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const queryParams = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(7),
    commentLimit: z.coerce.number().int().min(0).max(50).default(10),
  })
  .strict();

function bandFor(score: number): "promoter" | "passive" | "detractor" {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

router.get("/admin/nps/recent", requireAdmin, async (req, res) => {
  const parsed = queryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_query",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const { days, commentLimit } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);

  // Pull every NPS row in the window — typical volume is well under
  // 1k/week even at scale, so a single read is cheaper than two
  // round-trips for separate aggregations + tail.
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_order_nps_responses")
    .select("id, order_id, score, comment, created_at")
    .gte("created_at", cutoff.toISOString())
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw error;

  // Dedup to most-recent rating per order. Sorted desc above, so the
  // first occurrence wins.
  const seen = new Set<string>();
  const latestPerOrder: Array<{
    id: string;
    order_id: string;
    score: number;
    comment: string | null;
    created_at: string;
  }> = [];
  for (const r of rows ?? []) {
    if (seen.has(r.order_id)) continue;
    seen.add(r.order_id);
    latestPerOrder.push(r);
  }

  const counts = { promoter: 0, passive: 0, detractor: 0 };
  for (const r of latestPerOrder) {
    counts[bandFor(r.score)] += 1;
  }
  const total = latestPerOrder.length;
  const npsScore =
    total === 0
      ? null
      : Math.round(((counts.promoter - counts.detractor) / total) * 100);

  // Comment tail — recent rows with non-empty comments. We surface
  // the score alongside so the admin can see context.
  const commentTail = (rows ?? [])
    .filter((r) => r.comment && r.comment.trim().length > 0)
    .slice(0, commentLimit)
    .map((r) => ({
      id: r.id,
      orderId: r.order_id,
      score: r.score,
      comment: r.comment,
      createdAt: r.created_at,
    }));

  res.json({
    windowDays: days,
    total,
    counts,
    npsScore,
    comments: commentTail,
  });
});

export default router;
