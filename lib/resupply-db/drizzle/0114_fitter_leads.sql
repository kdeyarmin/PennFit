-- 0114_fitter_leads — persist email + marketing opt-in captured at
-- the start of the fitter flow (POST /shop/fitter-leads, called from
-- the /consent page in cpap-fitter).
--
-- Why this table exists:
--   The fitter walks the patient through five screens of measurement
--   and recommendation work. The /consent page now gates entry on a
--   valid email + an explicit marketing opt-in checkbox. Capturing the
--   pair here means we can re-engage patients who abandon mid-flow —
--   the order row never gets created for them, so without this table
--   we'd have no record at all.
--
-- One row per submission:
--   No uniqueness on email. A patient who clears their browser session
--   and starts the fitter again will create a second row; that's fine
--   for our use case (we want the most-recent opt-in to stand) and
--   keeps the insert path free of conflict-handling.
--
-- PHI handling:
--   email is contact info, not PHI by itself. submitter_ip + user_agent
--   are persisted only to support rate-limit forensics; both can be
--   nulled without losing the lead.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."fitter_leads" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "email" text NOT NULL,
  "marketing_opt_in" boolean NOT NULL,
  "submitter_ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Lookup by email lets a CSR check whether a patient who just called
-- in had a prior fitter-flow opt-in on file. Plain B-tree because the
-- API layer lowercases the value before insert.
CREATE INDEX IF NOT EXISTS "fitter_leads_email_idx"
  ON "resupply"."fitter_leads" ("email");
--> statement-breakpoint

-- Newest-first scans for the abandoned-flow re-engagement dispatcher.
CREATE INDEX IF NOT EXISTS "fitter_leads_created_idx"
  ON "resupply"."fitter_leads" ("created_at" DESC);
