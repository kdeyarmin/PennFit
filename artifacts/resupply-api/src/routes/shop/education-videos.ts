// GET /shop/education-videos — public education-video library for the
// storefront /learn pages (RT #25). Active videos grouped by topic in
// display order. No auth, no PHI. Fail-soft: an empty catalog returns
// `{ groups: [] }` and the storefront renders an empty state.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  groupActiveVideosByTopic,
  type EducationVideo,
} from "../../lib/storefront/education-videos";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { requestHost } from "../../lib/request-host";
import { resolveBrandOrgIdByHost } from "../../lib/tenant-branding";

const router: IRouter = Router();

router.get("/shop/education-videos", async (req, res) => {
  try {
    // education_videos is per-tenant (migration 0358): each tenant curates
    // its own /learn library. Resolve by verified custom domain / subdomain
    // ONLY (resolveBrandOrgIdByHost) — platform host / unbound → null and an
    // empty library, never the seed tenant's videos. Fail-soft on miss.
    const orgId = await resolveBrandOrgIdByHost(requestHost(req));
    if (!orgId) {
      res.json({ groups: [] });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("education_videos")
      .select(
        "id, title, topic, description, video_url, thumbnail_url, duration_seconds, sort_order, active",
      )
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .limit(500);
    if (error) {
      // Fail-soft — the learn page shouldn't break if the catalog query
      // hiccups; return an empty library.
      logger.warn(
        { err: error.message },
        "shop/education-videos: query failed",
      );
      res.json({ groups: [] });
      return;
    }
    const videos: EducationVideo[] = (data ?? []).map(
      (r: Record<string, unknown>) => {
        const row = r;
        return {
          id: String(row.id),
          title: String(row.title ?? ""),
          topic: String(row.topic ?? "other"),
          description: (row.description as string | null) ?? null,
          videoUrl: String(row.video_url ?? ""),
          thumbnailUrl: (row.thumbnail_url as string | null) ?? null,
          durationSeconds:
            typeof row.duration_seconds === "number"
              ? row.duration_seconds
              : null,
          sortOrder: typeof row.sort_order === "number" ? row.sort_order : 0,
          active: row.active !== false,
        };
      },
    );
    res.json({ groups: groupActiveVideosByTopic(videos) });
  } catch (err) {
    logger.warn({ err: redactDbErr(err) }, "shop/education-videos: threw");
    res.json({ groups: [] });
  }
});

export default router;
