-- 0205_education_videos — RT #25: short-video education library.
--
-- A small catalog of educational clips (mask fitting, ramp/comfort,
-- cleaning, troubleshooting) surfaced on the storefront /learn pages and
-- sendable from an RT encounter. Per ground rule 9 this is "video
-- hosting", but we keep it VENDOR-AGNOSTIC: `video_url` is a fully-
-- qualified link to wherever the clip lives (YouTube / Vimeo / a CDN /
-- Supabase Storage) — no vendor SDK, no API key, so nothing to fail at
-- boot. The surfaces degrade gracefully when the catalog is empty
-- (no active rows → "no videos yet"), which is the fail-soft posture.
--
-- Additive, no backfill. Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."education_videos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "topic" text NOT NULL DEFAULT 'other',
  "description" text,
  -- Fully-qualified URL to the hosted clip (vendor-agnostic).
  "video_url" text NOT NULL,
  "thumbnail_url" text,
  "duration_seconds" integer,
  "sort_order" integer NOT NULL DEFAULT 0,
  "active" boolean NOT NULL DEFAULT true,
  "created_by_email" text NOT NULL DEFAULT 'unknown',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "education_videos_topic_enum"
    CHECK ("topic" IN (
      'getting_started',
      'mask_fitting',
      'ramp_comfort',
      'cleaning',
      'troubleshooting',
      'travel',
      'other'
    )),
  CONSTRAINT "education_videos_duration_nonneg"
    CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0)
);
--> statement-breakpoint

-- Public list: active videos in display order.
CREATE INDEX IF NOT EXISTS "education_videos_active_sort_idx"
  ON "resupply"."education_videos" ("active", "sort_order");
