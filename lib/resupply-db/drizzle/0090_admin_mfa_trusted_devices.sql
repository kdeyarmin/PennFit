-- Defensive create (from-scratch replay support): this migration
-- references resupply.admin_users via a foreign key, but earlier
-- migrations (0080, 0084, 0085, 0087) also reference it. The canonical
-- CREATE lives in 0020. A fresh `migrate.mjs` run applies files in
-- numeric order, so we create the table defensively here (matching
-- 0020's definition, IF NOT EXISTS) so the foreign key below resolves.
-- No-op on any DB that already has it.
CREATE TABLE IF NOT EXISTS "resupply"."admin_users" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  "email_lower" text NOT NULL UNIQUE,
  "clerk_user_id" text UNIQUE,
  "role" text NOT NULL DEFAULT 'agent',
  "status" text NOT NULL DEFAULT 'pending',
  "clerk_invitation_id" text,
  "display_name" text,
  "notes" text,
  "invited_by" text,
  "invited_at" timestamp with time zone NOT NULL DEFAULT now(),
  "accepted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
