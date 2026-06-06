// GET /admin/voice/metrics?days=30 — voice-call timing metrics for the
// operations center. Reads the resupply.voice_calls timing ledger
// (populated by /voice/status-callback) and returns volume, answer
// rate, handle time, and ring time over the window.
//
// Read-only aggregation; no PHI (the ledger holds no phone numbers).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  aggregateVoiceMetrics,
  type VoiceCallRow,
} from "../../lib/analytics/voice-metrics";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

router.get(
  "/admin/voice/metrics",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const supabase = getSupabaseServiceRoleClient();

    const { data, error } = await supabase
      .schema("resupply")
      .from("voice_calls")
      .select("status, direction, duration_seconds, initiated_at, answered_at")
      .gte("created_at", cutoff)
      .limit(50000);
    if (error) throw error;

    const rows: VoiceCallRow[] = (data ?? []).map((r) => ({
      status: r.status,
      direction: r.direction,
      durationSeconds: r.duration_seconds,
      initiatedAt: r.initiated_at,
      answeredAt: r.answered_at,
    }));
    res.json({ windowDays: days, ...aggregateVoiceMetrics(rows) });
  },
);

export default router;
