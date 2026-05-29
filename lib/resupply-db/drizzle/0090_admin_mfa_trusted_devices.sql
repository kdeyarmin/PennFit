-- Defensive create (from-scratch replay support): this migration
-- references resupply.admin_users via a foreign key, but the canonical
-- CREATE lives in 0093 — the table was hand-created on the live DB
-- during the in-house-auth cutover and only retro-added to the
-- migration timeline out of numeric order (see 0093's header). A fresh
-- `migrate.mjs` run applies files in numeric order, so we create the
-- table defensively here (byte-identical to 0093, IF NOT EXISTS) so the
-- foreign key below resolves. No-op on any DB that already has it.
CREATE TABLE IF NOT EXISTS "resupply"."admin_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
