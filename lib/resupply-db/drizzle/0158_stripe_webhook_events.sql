-- stripe_webhook_events: idempotency table for Stripe webhook redelivery.
--
-- Why
-- ---
-- The webhook handler in artifacts/resupply-api/src/lib/stripe/
-- webhook-handler.ts dispatches each verified event through a switch
-- statement that runs side effects (markPaid → items upsert, refund
-- mirroring, subscription cancellation, etc.). Stripe redelivers any
-- 2xx-not-received-within-policy event with the SAME event.id. Today
-- the only thing keeping the handler safe across redelivery is per-
-- table idempotency:
--   * markPaid()                 — re-stamps paid_at; the UPDATE is
--                                  guarded by stripe_session_id but
--                                  the audit row is best-effort and
--                                  can double-write.
--   * upsertOrderItemsFromSession — UNIQUE on
--                                  (stripe_session_id, product_id,
--                                  price_id) — safe.
--   * refund / cancellation mirrors — write paths vary; some are
--                                  safe under redelivery, some emit
--                                  duplicate audit rows.
--
-- The cleanest gate is to dedupe at the EVENT level: a single
-- (event_id UNIQUE) table that the handler INSERTs into BEFORE the
-- switch. On UNIQUE conflict the handler returns 200 + a "deduped"
-- marker; Stripe stops retrying and no downstream side effects fire.
-- Once an event has been recorded here we own the idempotency
-- guarantee at the only layer that has full visibility — every
-- branch downstream can stay focused on its own correctness without
-- carrying the Stripe-redelivery story.
--
-- Schema
-- ------
-- event_id     — Stripe event id (e.g. `evt_1Nx...`). 64 chars is
--                generous against any future format change. UNIQUE.
-- event_type   — Stripe event type string (`checkout.session.completed`
--                etc.). Stored for retrospective grep / dashboards;
--                not used for dispatch logic (handler reads
--                event.type from the verified Stripe payload).
-- received_at  — first-seen wall-clock timestamp.
--
-- Per ADR 003 — versioned hand-authored migration. No DROP/INDEX
-- cleanup needed; the table is new.

CREATE TABLE IF NOT EXISTS "resupply"."stripe_webhook_events" (
  "event_id" text PRIMARY KEY,
  "event_type" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Pruning: stripe_webhook_events grows monotonically. Stripe's
-- redelivery window is 3 days; rows older than ~14 days are no
-- longer load-bearing. A future worker can DELETE old rows in the
-- same idempotency-prune cadence already used by
-- idempotency_keys (see artifacts/resupply-api/src/worker/jobs/
-- idempotency-keys-prune.ts). Not wired up in this migration —
-- single hand-applied prune is the right shape until volume
-- justifies a cron. Index supports that future scan without
-- bloating the small write path the table is sized for.
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_received_at_idx"
  ON "resupply"."stripe_webhook_events" ("received_at");
