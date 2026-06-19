// /admin/reorder-reminders/* — reorder-reminder funnel analytics.
//
//   GET /admin/reorder-reminders/funnel?days=30
//     due → reminded → confirmed → shipped, with a per-channel
//     (sms / email / voice) breakdown.
//
// Read-only aggregation over data we already have (episodes, conversations,
// fulfillments). No new schema. The window is `days` (1..365, default 30).
// Aggregation math lives in lib/analytics/reorder-funnel.ts; this route is the
// org-scoped DB read + window validation. Mirrors routes/admin/analytics.ts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  aggregateReorderFunnel,
  FUNNEL_CHANNELS,
  type ReorderFunnelConversation,
  type ReorderFunnelEpisode,
} from "../../lib/analytics/reorder-funnel";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const PAGE_SIZE = 1000;

router.get(
  "/admin/reorder-reminders/funnel",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const now = Date.now();
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const nowIso = new Date(now).toISOString();
    // Trim-check, not just falsy: getOrgScopedClient throws on a blank/
    // whitespace orgId — return the controlled error instead.
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Episodes that became DUE in the window — bound on `due_at` (actual
    // reorder eligibility), not `created_at` (row-insert time). Excludes
    // episodes whose due date is still in the future. Keyset-paged (PostgREST
    // caps a page at ~1000 rows); `episodes.due_at` is indexed.
    const episodes: ReorderFunnelEpisode[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("episodes")
        .select("id, status")
        .gte("due_at", cutoff)
        .lte("due_at", nowIso)
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) episodes.push({ id: r.id, status: r.status });
      if (data.length < PAGE_SIZE) break;
    }

    if (episodes.length === 0) {
      res.json({
        windowDays: days,
        ...aggregateReorderFunnel([], [], new Set()),
      });
      return;
    }

    const episodeIds = episodes.map((e) => e.id);

    // Reminder conversations on the ladder channels, for those episodes.
    const conversations: ReorderFunnelConversation[] = [];
    for (let i = 0; i < episodeIds.length; i += 200) {
      const idChunk = episodeIds.slice(i, i + 200);
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("conversations")
          .select("episode_id, channel")
          .in("episode_id", idChunk)
          .in("channel", [...FUNNEL_CHANNELS])
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const c of data) {
          if (c.episode_id) {
            conversations.push({ episodeId: c.episode_id, channel: c.channel });
          }
        }
        if (data.length < PAGE_SIZE) break;
      }
    }

    // Episodes with a shipped fulfillment.
    const shippedEpisodeIds = new Set<string>();
    for (let i = 0; i < episodeIds.length; i += 200) {
      const idChunk = episodeIds.slice(i, i + 200);
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("fulfillments")
          .select("episode_id, shipped_at")
          .in("episode_id", idChunk)
          .not("shipped_at", "is", null)
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const f of data) {
          if (f.episode_id) shippedEpisodeIds.add(f.episode_id);
        }
        if (data.length < PAGE_SIZE) break;
      }
    }

    const result = aggregateReorderFunnel(
      episodes,
      conversations,
      shippedEpisodeIds,
    );
    res.json({ windowDays: days, ...result });
  },
);

export default router;
