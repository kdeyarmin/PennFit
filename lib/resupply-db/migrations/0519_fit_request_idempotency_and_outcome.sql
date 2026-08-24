-- 0519_fit_request_idempotency_and_outcome — stop a re-submit from
-- queueing the same patient twice, and give `closed` an outcome so the
-- fitting → dispense loop has a writer again.
--
-- Two follow-ups to 0518, both consequences of the fitter ending in a
-- request rather than an order.
--
-- 1. DUPLICATE SUBMISSIONS
-- ------------------------
-- /fit-request is reachable by back-navigation and its submit button is
-- clickable twice. Either one filed a SECOND queue row and sent a SECOND
-- staff notification for one patient asking for one thing. Staff then
-- work a phantom.
--
-- The fix is a key the database enforces, not a check the route makes:
-- two concurrent double-click submissions both pass a read-then-write
-- guard, and only a unique index arbitrates. `dedupe_hash` is a digest of
-- what makes two submissions the SAME ask — request type plus the
-- patient's identity and contact details — computed server-side, so it
-- costs the client nothing and cannot be spoofed into merging two
-- different patients.
--
-- WHY THE INDEX IS PARTIAL, AND WHY ON `status <> 'closed'`
-- ---------------------------------------------------------
-- A plain unique index would say "this patient may never ask twice",
-- which is wrong: a patient legitimately comes back weeks later for a new
-- mask. A time window would be arbitrary and would need a bucket column
-- that makes 23:59 and 00:01 different requests.
--
-- Scoping to still-open requests says the true rule instead: while the
-- DME still has this person in the queue for this ask, another identical
-- ask is the SAME ask. Once staff close it, the loop is finished and a
-- fresh identical request is a genuinely new one. No window, no bucket,
-- no clock.
--
-- 2. CLOSING WITH AN OUTCOME
-- --------------------------
-- `status = 'closed'` says the CSR is finished; it does not say what
-- happened. That gap is now load-bearing, because 0518 removed the
-- fitter's cash-pay checkout — which was the ONLY writer of
-- `fit_sessions.dispensed_at` and `ordered_mask_model_id`.
--
-- Those two columns have three readers: the outcomes dashboard's dispense
-- rate, its accepted-vs-overridden split, and the re-fit campaign's
-- discontinued-mask branch. Leaving them unwritten is precisely the bug
-- `lib/fitting/order-link.ts` was written to fix ("the outcome dashboard
-- reported a dispense rate of zero forever"). Recording HOW a request
-- closed lets the fulfilled ones stamp the fitting again, on the path
-- where the outcome now actually happens.
--
-- `closed_outcome` is nullable: every row that exists today closed
-- without one, and NULL honestly means "we don't know" rather than
-- guessing 'fulfilled' and inflating the dispense rate on backfill.

ALTER TABLE "resupply"."fitter_fit_requests"
  ADD COLUMN IF NOT EXISTS "dedupe_hash" text;

ALTER TABLE "resupply"."fitter_fit_requests"
  ADD COLUMN IF NOT EXISTS "closed_outcome" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fitter_fit_requests_closed_outcome_chk'
  ) THEN
    ALTER TABLE "resupply"."fitter_fit_requests"
      ADD CONSTRAINT "fitter_fit_requests_closed_outcome_chk"
      CHECK (
        "closed_outcome" IS NULL
        OR "closed_outcome" IN (
          'fulfilled',
          'not_proceeding',
          'unreachable',
          'duplicate'
        )
      );
  END IF;
END $$;

-- The idempotency key. Partial on BOTH conditions:
--   * `dedupe_hash IS NOT NULL` so the rows that predate this migration
--     (and any future path that deliberately declines to dedupe) never
--     collide with each other on a shared NULL.
--   * `status <> 'closed'` for the reason argued at the top.
CREATE UNIQUE INDEX IF NOT EXISTS "fitter_fit_requests_open_dedupe_idx"
  ON "resupply"."fitter_fit_requests" ("org_id", "dedupe_hash")
  WHERE "dedupe_hash" IS NOT NULL AND "status" <> 'closed';

-- Reporting reads "how did fit requests turn out" by outcome; the
-- fulfilled ones are also what the dispense stamp follows.
CREATE INDEX IF NOT EXISTS "fitter_fit_requests_org_outcome_idx"
  ON "resupply"."fitter_fit_requests" ("org_id", "closed_outcome")
  WHERE "closed_outcome" IS NOT NULL;

COMMENT ON COLUMN "resupply"."fitter_fit_requests"."dedupe_hash" IS
  'Server-computed digest of request_type + patient identity/contact. Unique per org among requests that are not yet closed, so a double-click or a back-navigation re-submit returns the existing request instead of queueing a second one.';

COMMENT ON COLUMN "resupply"."fitter_fit_requests"."closed_outcome" IS
  'How a closed request turned out. ''fulfilled'' stamps fit_sessions.dispensed_at / ordered_mask_model_id on the linked fitting, which is what feeds the outcomes dashboard and the re-fit campaign. NULL means the request was closed without recording an outcome.';
