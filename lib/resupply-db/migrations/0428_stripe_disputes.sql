-- 0428_stripe_disputes — persist Stripe chargeback disputes.
--
-- charge.dispute.* events were only WARN-logged (lib/stripe/webhook-handler.ts),
-- so a missed alert = a silently lost dispute deadline. This adds a disputes
-- table the webhook upserts into (created / updated / closed) and an admin
-- worklist reads (open disputes ordered by evidence deadline). Additive +
-- idempotent.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."stripe_disputes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid,
  "stripe_dispute_id" text NOT NULL,
  "stripe_charge_id" text,
  "order_id" uuid
    REFERENCES "resupply"."shop_orders"("id") ON DELETE SET NULL,
  "amount_cents" bigint NOT NULL DEFAULT 0,
  "currency" text,
  "reason" text,
  -- Stripe dispute.status (free text — Stripe may add values).
  "status" text,
  "evidence_due_by" timestamp with time zone,
  "is_charge_refundable" boolean,
  "opened_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "outcome" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per Stripe dispute; the webhook upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_disputes_dispute_id_unique"
  ON "resupply"."stripe_disputes" ("stripe_dispute_id");
--> statement-breakpoint

-- Open-dispute worklist (the deadline-bearing ones), oldest deadline first.
CREATE INDEX IF NOT EXISTS "stripe_disputes_open_idx"
  ON "resupply"."stripe_disputes" ("evidence_due_by")
  WHERE "closed_at" IS NULL;
