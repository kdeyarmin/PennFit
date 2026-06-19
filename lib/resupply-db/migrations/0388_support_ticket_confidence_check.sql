-- 0388_support_ticket_confidence_check — bound support_tickets.bot_confidence
-- to the [0,1] range it is documented to hold.
--
-- bot_confidence (0385) stores an LLM-reported answer confidence (0..1) used
-- to drive auto-answer / triage thresholds, but the column is a bare
-- `numeric` with no range constraint — a model returning 1.7 or a negative
-- is silently persisted and would mis-drive any "auto-answer above
-- threshold" read. Add the CHECK, consistent with the status/actor CHECK
-- discipline already in 0385.
--
-- Defensive: clamp any pre-existing out-of-range rows BEFORE adding the
-- constraint so the ADD can never fail on existing data, and guard the ADD
-- so a re-apply is a no-op (idempotent — ADR 003).

UPDATE "resupply"."support_tickets"
SET "bot_confidence" = LEAST(1, GREATEST(0, "bot_confidence"))
WHERE "bot_confidence" IS NOT NULL
  AND ("bot_confidence" < 0 OR "bot_confidence" > 1);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_tickets_bot_confidence_range'
      AND conrelid = 'resupply.support_tickets'::regclass
  ) THEN
    ALTER TABLE "resupply"."support_tickets"
      ADD CONSTRAINT "support_tickets_bot_confidence_range"
      CHECK ("bot_confidence" IS NULL
             OR ("bot_confidence" >= 0 AND "bot_confidence" <= 1));
  END IF;
END
$$;
