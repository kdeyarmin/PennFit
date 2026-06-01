// /admin/education-videos — manage the education-video library (RT #25).
//
//   GET   /admin/education-videos        (reports.read) — all videos
//   POST  /admin/education-videos        (admin.tools.manage) — add
//   PATCH /admin/education-videos/:id     (admin.tools.manage) — edit /
//                                         (de)activate / reorder
//
// Content management, no PHI. Public read is the separate
// GET /shop/education-videos.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isEducationTopic } from "../../lib/storefront/education-videos";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const httpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => u.startsWith("https://"), "must be https");

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    topic: z.string().refine(isEducationTopic, "unknown topic"),
    description: z.string().trim().max(2000).nullable().optional(),
    videoUrl: httpsUrl,
    thumbnailUrl: httpsUrl.nullable().optional(),
    durationSeconds: z.coerce
      .number()
      .int()
      .min(0)
      .max(86_400)
      .nullable()
      .optional(),
    sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
  })
  .strip();

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    topic: z.string().refine(isEducationTopic, "unknown topic").optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    videoUrl: httpsUrl.optional(),
    thumbnailUrl: httpsUrl.nullable().optional(),
    durationSeconds: z.coerce
      .number()
      .int()
      .min(0)
      .max(86_400)
      .nullable()
      .optional(),
    sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
    active: z.boolean().optional(),
  })
  .strip();

router.get(
  "/admin/education-videos",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("education_videos")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("title", { ascending: true })
      .limit(1000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    res.json({ videos: data ?? [] });
  },
);

router.post(
  "/admin/education-videos",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("education_videos")
      .insert({
        title: b.title,
        topic: b.topic,
        description: b.description ?? null,
        video_url: b.videoUrl,
        thumbnail_url: b.thumbnailUrl ?? null,
        duration_seconds: b.durationSeconds ?? null,
        sort_order: b.sortOrder ?? 0,
        active: true,
        created_by_email: req.adminEmail ?? "unknown",
      } as never)
      .select("id")
      .maybeSingle();
    if (error || !data) {
      res.status(500).json({ error: "create_failed" });
      return;
    }
    res.status(201).json({ id: (data as { id: string }).id });
  },
);

router.patch(
  "/admin/education-videos/:id",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const idOk = z.string().uuid().safeParse(req.params.id);
    if (!idOk.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (b.title !== undefined) update.title = b.title;
    if (b.topic !== undefined) update.topic = b.topic;
    if (b.description !== undefined) update.description = b.description;
    if (b.videoUrl !== undefined) update.video_url = b.videoUrl;
    if (b.thumbnailUrl !== undefined) update.thumbnail_url = b.thumbnailUrl;
    if (b.durationSeconds !== undefined)
      update.duration_seconds = b.durationSeconds;
    if (b.sortOrder !== undefined) update.sort_order = b.sortOrder;
    if (b.active !== undefined) update.active = b.active;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("education_videos")
      .update(update as never)
      .eq("id", idOk.data)
      .select("id")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
