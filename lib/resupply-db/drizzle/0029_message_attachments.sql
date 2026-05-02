-- Message attachments — Twilio MMS media (and any future channel media).
--
-- Why a separate table rather than columns on `messages`:
--   Twilio MMS supports up to 10 media per message and we want to
--   preserve all of them (a patient texting a multi-page Rx photo
--   can send 4-5 images in one MMS). One-to-many demands its own
--   table. Email file attachments will land here too once the
--   inbound email path needs them.
--
-- Why object storage rather than a Postgres bytea column:
--   Mirrors the prescriptions decision (migration 0015): scans are
--   200KB-4MB blobs. Postgres bytea bloats backup/restore size
--   gratuitously when GCS already provides AES-256 at rest.
--
-- Columns:
--   * object_key — GCS path inside PRIVATE_OBJECT_DIR
--     (e.g. "/objects/uploads/<uuid>"). TEXT, not URL, so we can
--     rotate the bucket without rewriting audit history.
--   * filename — best-effort original filename. For MMS this is a
--     fabricated "mms-<sid>.jpg" because Twilio doesn't supply one;
--     for future email attachments it will be the real filename.
--     Capped at 255 to match prescription attachment column.
--   * content_type — server-validated MIME at ingest time.
--     Persisted so the download endpoint can set Content-Type
--     without re-deriving from the filename extension.
--   * size_bytes — actual bytes uploaded; redundant with GCS
--     metadata but cheap to materialise here for "120KB" UI labels.
--   * twilio_media_sid — Twilio's globally unique media SID.
--     Nullable because future channels (inbound email) won't have
--     one. Unique partial index so a Twilio webhook replay can't
--     double-ingest the same media into two attachment rows.
--   * created_at — ingest time (NOT message receipt time, so the
--     latency between webhook arrival and GCS upload is visible
--     for debugging).
--
-- ON DELETE CASCADE on message_id: deleting a message removes its
-- attachment rows too. The orphan GCS bytes are reaped by the
-- existing prescription-attachment sweep job (which reaps anything
-- under <entity-prefix>/uploads/ that no DB row references — the
-- sweep already operates on a Set of referenced object keys, so
-- adding this table to its reference query is the only follow-up).
--
-- Per ADR 003 — versioned hand-authored migration; this codebase
-- does not use db:push because db:push silently rewrites columns
-- once PHI lands.

CREATE TABLE IF NOT EXISTS "resupply"."message_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "message_id" uuid NOT NULL REFERENCES "resupply"."messages"("id") ON DELETE CASCADE,
  "object_key" text NOT NULL,
  "filename" varchar(255),
  "content_type" varchar(120) NOT NULL,
  "size_bytes" integer NOT NULL,
  "twilio_media_sid" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "message_attachments_message_idx"
  ON "resupply"."message_attachments" ("message_id");

-- Replay protection — same logic as the messages_twilio_sid_unique
-- partial index from migration 0028: a Twilio webhook captured and
-- replayed verbatim must not insert a second attachment row for the
-- same media. Partial because non-Twilio attachments (future email
-- ingestion) carry NULL here.
CREATE UNIQUE INDEX IF NOT EXISTS "message_attachments_twilio_media_sid_unique"
  ON "resupply"."message_attachments" ("twilio_media_sid")
  WHERE "twilio_media_sid" IS NOT NULL;
