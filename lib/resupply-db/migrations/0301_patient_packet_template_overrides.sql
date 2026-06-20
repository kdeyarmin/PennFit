-- Patient packet template overrides + per-packet content snapshots.
--
-- Until now the e-sign packet document content lived only in code
-- (artifacts/resupply-api/src/lib/patient-packet/templates.ts). This
-- migration makes the content operator-editable on two levels:
--
--   1. patient_packet_template_overrides — a PERMANENT, per-document-key
--      override of the built-in template (title + structured sections).
--      One row per document key; deleting the row reverts to the code
--      default. Content is the same structured-sections JSON the code
--      templates produce (headings / paragraphs / bullets — never HTML),
--      and may carry {{merge_tokens}} resolved at render time from app
--      data (company profile, packet recipient).
--
--   2. patient_packet_documents.content_sections — a snapshot of the
--      effective sections (default or override, plus any one-off edit
--      made for that packet alone) taken at SEND time. Renders (signing
--      UI + signed PDF) read the snapshot, so a later template edit
--      never rewrites what a patient saw or signed. NULL on rows created
--      before this migration — those keep rendering from the code
--      template by key (the historical behavior).

CREATE TABLE IF NOT EXISTS "resupply"."patient_packet_template_overrides" (
  -- Stable template key, e.g. 'assignment_of_benefits'. One override
  -- per built-in document.
  "document_key" text PRIMARY KEY,
  "title" text NOT NULL,
  -- Structured sections: [{heading?, paragraphs?: text[], bullets?: text[]}]
  "sections" jsonb NOT NULL,
  -- Bumped on every save; folded into the content_version snapshotted
  -- onto packets so a signed PDF records which revision it rendered.
  "revision" integer NOT NULL DEFAULT 1,
  "updated_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "resupply"."patient_packet_documents"
  ADD COLUMN IF NOT EXISTS "content_sections" jsonb;
