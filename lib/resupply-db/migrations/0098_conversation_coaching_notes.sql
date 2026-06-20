-- conversation_coaching_notes — supervisor-authored coaching
-- feedback on CSR conversations. See schema for the rationale.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."conversation_coaching_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" uuid NOT NULL REFERENCES "resupply"."conversations"("id") ON DELETE CASCADE,
  "target_user_id" text NOT NULL,
  "author_user_id" text NOT NULL,
  "kind" varchar(16) NOT NULL DEFAULT 'suggestion',
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_coaching_notes_kind_enum"
    CHECK ("kind" IN ('praise','suggestion','concern'))
);

CREATE INDEX IF NOT EXISTS "conversation_coaching_notes_conv_idx"
  ON "resupply"."conversation_coaching_notes" ("conversation_id");

CREATE INDEX IF NOT EXISTS "conversation_coaching_notes_target_idx"
  ON "resupply"."conversation_coaching_notes" ("target_user_id");
