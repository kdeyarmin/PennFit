-- 0428_claim_appeal_outcome — appeal win-rate + response-aging tracking.
-- (renumbered from 0427 to clear a prefix collision with main's
--  0427_tenant_billing_paywall.)
--
-- claim_appeal_letters (migration 0137) recorded the letter plus its
-- delivery_method / delivered_at, but nothing captured the PAYER'S RESPONSE,
-- so appeal win-rate and the appeal-response clock could not be measured. This
-- adds two nullable columns (responded_at + outcome) and a partial "awaiting
-- response" aging index. Additive + idempotent; no existing read/write changes
-- (both columns default NULL, meaning "no payer response yet").
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."claim_appeal_letters"
  ADD COLUMN IF NOT EXISTS "responded_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."claim_appeal_letters"
  ADD COLUMN IF NOT EXISTS "outcome" text;
--> statement-breakpoint

-- Constrain outcome to the known set (NULL = no payer response yet).
-- ADD CONSTRAINT has no IF NOT EXISTS, so guard on the catalog.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'resupply.claim_appeal_letters'::regclass
      AND conname = 'claim_appeal_letters_outcome_enum'
  ) THEN
    ALTER TABLE "resupply"."claim_appeal_letters"
      ADD CONSTRAINT "claim_appeal_letters_outcome_enum"
      CHECK (
        "outcome" IS NULL
        OR "outcome" IN (
          'pending', 'overturned', 'upheld', 'partial', 'withdrawn'
        )
      );
  END IF;
END $$;
--> statement-breakpoint

-- Aging worklist: appeals that have been delivered but have no payer
-- response yet. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS "claim_appeal_letters_awaiting_response_idx"
  ON "resupply"."claim_appeal_letters" ("delivered_at")
  WHERE "outcome" IS NULL AND "delivered_at" IS NOT NULL;
