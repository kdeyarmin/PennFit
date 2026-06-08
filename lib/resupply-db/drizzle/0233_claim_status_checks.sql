-- 0233_claim_status_checks — X12 276/277 claim-status inquiry ledger
-- (biller #B3).
--
-- The 837 (submit) + 835 (ERA) + 270/271 (eligibility) round-trips
-- already have their ledgers; this is the missing one: a record of each
-- 276 claim-status inquiry we send and the 277 response we get back, so
-- a biller can proactively ask "where's my claim?" instead of waiting
-- for the ERA. Mirrors eligibility_checks (0-config plain table, service-
-- role only; no PHI beyond the claim/patient FKs governed elsewhere).
--
-- The 276 builder + 277 parser are the pure cores landed separately; this
-- table is what the submit route writes and the Office Ally poller
-- (case "277" → dispatch277) updates when the response lands. Per ADR
-- 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."claim_status_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "claim_id" uuid NOT NULL REFERENCES "resupply"."insurance_claims"("id"),
  "payer_profile_id" uuid REFERENCES "resupply"."payer_profiles"("id"),
  "isa_control_number" text,
  "gs_control_number" text,
  "outbound_file_name" text,
  "trace_reference" text,
  "status" text NOT NULL DEFAULT 'submitted',
  "category_code" text,
  "status_code" text,
  "outcome" text,
  "total_charge_cents" integer,
  "total_paid_cents" integer,
  "parsed_response_json" jsonb,
  "error_message" text,
  "requested_by_email" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "responded_at" timestamp with time zone,
  "applied_to_inbound_file_id" uuid,
  CONSTRAINT "claim_status_checks_status_chk" CHECK (
    "status" IN ('submitted', 'transport_failed', 'parsed', 'error')
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claim_status_checks_claim_idx"
  ON "resupply"."claim_status_checks" ("claim_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_status_checks_isa_idx"
  ON "resupply"."claim_status_checks" ("isa_control_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_status_checks_status_idx"
  ON "resupply"."claim_status_checks" ("status");
