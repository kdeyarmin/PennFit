-- 0191_setup_checklist — Phase 1 (RT #27): new-patient setup-guidance
-- checklist.
--
-- Why this exists
-- ---------------
-- An RT walking a new patient through first-night setup (mask seal,
-- humidifier, ramp, cleaning, pressure comfort, app pairing) wants a
-- simple per-patient checklist to track + check off on a call — so the
-- next person can see what's done. One row per (patient, step); the
-- canonical step list lives in the route (a code constant), this table
-- just records each step's status.
--
-- Gated by the F3 clinical perms (clinical.read / clinical.note.write) —
-- no new permission. Soft patient ref (no FK), RLS deny-all. Per ADR 003.

CREATE TABLE IF NOT EXISTS "resupply"."setup_checklist_items" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "patient_id" text NOT NULL,
  "step_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "note" text,
  "completed_by_email" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "setup_checklist_items_unique" UNIQUE ("patient_id", "step_key")
);
--> statement-breakpoint

ALTER TABLE "resupply"."setup_checklist_items"
  DROP CONSTRAINT IF EXISTS "setup_checklist_items_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."setup_checklist_items"
  ADD CONSTRAINT "setup_checklist_items_status_enum"
  CHECK ("status" IN ('pending', 'done', 'na'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "setup_checklist_items_patient_idx"
  ON "resupply"."setup_checklist_items" ("patient_id");
--> statement-breakpoint

ALTER TABLE "resupply"."setup_checklist_items" ENABLE ROW LEVEL SECURITY;
