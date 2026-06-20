-- 0033_in_app_conversations — let signed-in shop customers exchange
-- in-app messages with PennPaps customer-service reps using the SAME
-- `conversations` + `messages` tables that the resupply patient flow
-- already uses.
--
-- Why reuse the existing tables (vs. a parallel `shop_messages`):
--   * One source of truth for "everything we said to this person":
--     the existing /admin/conversations inbox surfaces in-app threads
--     alongside SMS / email naturally — no second inbox to build,
--     no second deduplication path to maintain.
--   * The assignment / SLA / escalation columns added in 0021 work
--     for in-app threads with no extra plumbing.
--   * The dispatch path in `lib/resupply-reminders/src/reply.ts`
--     already branches on `conv.channel`; adding an `'in_app'`
--     branch is a small surface-area extension.
--
-- The price we pay: `conversations.patient_id` and `episode_id` are
-- no longer NOT NULL — a row can now be subject-id-polymorphic.
-- The CHECK constraint below enforces XOR so we never end up with a
-- row that's neither (orphan) or both (ambiguous):
--
--   patient flow → patient_id IS NOT NULL AND episode_id IS NOT NULL
--                  AND customer_id IS NULL
--   in-app flow  → customer_id IS NOT NULL
--                  AND patient_id IS NULL AND episode_id IS NULL
--
-- Existing patient/episode rows automatically satisfy the constraint
-- (they have patient_id + episode_id set, customer_id is fresh-null).
--
-- The `'in_app'` channel value is enforced at the application layer
-- (Drizzle's TypeScript-only `text({ enum: [...] })` declaration) —
-- the underlying column is a plain `text`, no Postgres enum type to
-- alter.

ALTER TABLE "resupply"."conversations"
  ALTER COLUMN "patient_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."conversations"
  ALTER COLUMN "episode_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "customer_id" text;
--> statement-breakpoint

-- FK to shop_customers — ON DELETE CASCADE so removing a customer
-- account also tears down their in-app conversation history.
-- We DO NOT name a constraint on this when missing the IF NOT EXISTS
-- check on the constraint itself, so this migration must run exactly
-- once. If you need to re-run, drop the constraint first.
ALTER TABLE "resupply"."conversations"
  ADD CONSTRAINT "conversations_customer_id_fk"
  FOREIGN KEY ("customer_id")
  REFERENCES "resupply"."shop_customers"("customer_id")
  ON DELETE CASCADE;
--> statement-breakpoint

-- Subject-XOR check. Existing rows have (patient_id, episode_id) set
-- and customer_id NULL — they pass the first arm. New in-app rows
-- have customer_id set and (patient_id, episode_id) NULL — they
-- pass the second arm. Anything else (both set, neither set, partial
-- patient row missing episode_id, etc.) is rejected at write time.
ALTER TABLE "resupply"."conversations"
  ADD CONSTRAINT "conversations_subject_xor_check" CHECK (
    (
      "patient_id" IS NOT NULL
      AND "episode_id" IS NOT NULL
      AND "customer_id" IS NULL
    )
    OR
    (
      "customer_id" IS NOT NULL
      AND "patient_id" IS NULL
      AND "episode_id" IS NULL
    )
  );
--> statement-breakpoint

-- Lookup index for "show me this customer's in-app thread". Partial
-- (WHERE customer_id IS NOT NULL) so we don't carry index entries
-- for the millions of patient/episode rows we expect over time.
CREATE INDEX IF NOT EXISTS "conversations_customer_id_idx"
  ON "resupply"."conversations" ("customer_id")
  WHERE "customer_id" IS NOT NULL;
