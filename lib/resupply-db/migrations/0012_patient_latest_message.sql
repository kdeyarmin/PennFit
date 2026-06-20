-- Latest-message projection for patients (W3 T-A5/A6/A7).
--
-- Why a projection table and not a denormalized column on `patients`:
--   The patients table is referenced by many read paths and currently
--   carries identity + status only — adding encrypted message-preview
--   bytes would widen the row, double the write surface for PHI
--   (every inbound message would now also rewrite a patients row), and
--   couple unrelated update paths (admin edits to a patient and an
--   incoming SMS would both UPDATE patients, fighting for the same
--   row lock). A separate 1:1 projection keeps the PHI write surface
--   bounded to the new table and lets the patients table stay
--   identity-only.
--
-- Why upsert in-line rather than a trigger or async refresher:
--   In-line keeps the projection consistent with the inserting
--   transaction (no eventual-consistency window where the patients
--   list shows a stale "last message" while the conversation page
--   already has the new one). A trigger would work but pushes logic
--   into the DB layer where the encryption helper is harder to call;
--   we already have an application-side message-write helper, so a
--   single application-side upsert in that helper is the smallest
--   change.
--
-- Why include `last_message_conversation_id`:
--   The patients list will render an "Open conversation" link beside
--   the preview. Without the conversation id pre-projected, that link
--   would require a second query per row to re-derive it from the
--   most recent message — wasteful when we're already writing the
--   projection on every message.
--
-- Why an out-of-order guard in the upsert (in app code, not here):
--   Webhook redelivery and out-of-order SMS callbacks can deliver an
--   older message AFTER a newer one has already projected. The
--   application-side upsert uses a `WHERE EXCLUDED.last_message_at >=
--   patient_latest_message.last_message_at` guard so a stale event
--   never overwrites a fresher projection. We keep the guard in app
--   code (not as a partial-index UPSERT) because Postgres ON CONFLICT
--   doesn't support a WHERE on the conflict target's existing row;
--   the app-side conditional update is the cleanest expression.
--
-- Per ADR 003 — versioned hand-authored migration; this codebase does
-- not use db:push because db:push silently rewrites columns once PHI
-- lands.

CREATE TABLE IF NOT EXISTS "resupply"."patient_latest_message" (
  "patient_id" uuid PRIMARY KEY
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "last_message_at" timestamp with time zone NOT NULL,
  "last_message_direction" text NOT NULL,
  -- Encrypted preview (≤80 chars of plaintext) — uses the same
  -- pgcrypto helper as messages.body. Stored as bytea exactly like
  -- the source column.
  "last_message_preview" bytea NOT NULL,
  -- Nullable: if a conversation is later hard-deleted (we don't do
  -- this today, but the constraint should not cascade away the whole
  -- projection row if it ever happens), keep the rest of the row
  -- intact and let the link render disabled.
  "last_message_conversation_id" uuid
    REFERENCES "resupply"."conversations"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT NOW(),
  -- Direction is a closed enum mirrored from messages.direction.
  -- Cheap enum-style CHECK (not a Postgres ENUM type — keeps schema
  -- migrations cheap, matches messages.direction's text storage).
  CONSTRAINT "patient_latest_message_direction_chk"
    CHECK ("last_message_direction" IN ('inbound', 'outbound'))
);

-- Powers "patients sorted by most recent activity" — the patients
-- list's primary sort. DESC matches the read direction; index covers
-- both the sort and any "since" range filter the dashboard might add.
CREATE INDEX IF NOT EXISTS "patient_latest_message_recent_idx"
  ON "resupply"."patient_latest_message" ("last_message_at" DESC);
