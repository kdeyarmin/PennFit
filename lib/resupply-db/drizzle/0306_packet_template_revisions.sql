-- Patient packet template revision history.
--
-- Every permanent template edit (save or revert) appends one row here,
-- giving operators an audit trail of WHO changed WHICH e-sign document
-- wording WHEN — and the full content of every prior revision so an
-- accidental edit can be restored with one click. Append-only: rows are
-- never updated or deleted by the application.
--
-- This complements (does not replace) the snapshot invariant from
-- migration 0301: packets already sent render from their own
-- content_sections snapshot regardless of template history.

CREATE TABLE IF NOT EXISTS "resupply"."patient_packet_template_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Stable template key, e.g. 'assignment_of_benefits'.
  "document_key" text NOT NULL,
  -- 'saved'    — an override was created/updated (title+sections present)
  -- 'reverted' — the override was deleted (back to the code default)
  "action" text NOT NULL,
  -- The override's revision counter at the time of a save; NULL on revert.
  "revision" integer,
  "title" text,
  -- Token-form structured sections, exactly as saved; NULL on revert.
  "sections" jsonb,
  "changed_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "packet_template_revisions_key_idx"
  ON "resupply"."patient_packet_template_revisions"
  ("document_key", "created_at" DESC);
