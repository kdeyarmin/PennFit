-- 0457_claim_adr_audit_packets — Medicare ADR / audit-response queue and the
-- audit-packet builder that assembles the requested records into one PDF.
--
-- Why
-- ---
-- A payer or its audit contractor (RAC / CERT / TPE / UPIC, or a commercial
-- payer's medical-review unit) issues an Additional Documentation Request:
-- "send the records supporting claim X by <date>." For Medicare FFS the clock
-- is short and unforgiving — 30 calendar days from receipt — and a miss is an
-- automatic denial / recoupment. Nothing in the app tracked that deadline,
-- assembled the response, or recorded the outcome. Insufficient documentation
-- (not clinical disagreement) drives the large majority of PAP improper
-- payments, so the response has to be complete and self-evidencing.
--
-- This migration adds:
--   * claim_adr_requests   — one row per ADR: source/contractor, the hard
--     response deadline, lifecycle status, and outcome. `sla_status` is a
--     denormalised cache the sweep keeps in step (overdue / at_risk / …) so
--     the worklist doesn't recompute per row. Closely mirrors the bill-hold
--     pattern (0253) but for the post-adjudication audit lifecycle.
--   * claim_adr_documents  — the response checklist: one row per requested
--     item (keyed to the code-side AUDIT_PACKET_CATALOG), each outstanding,
--     attached (to a stored chart document), generated (system-derived), or
--     waived/na.
--   * audit_packets        — a record of each assembled packet PDF (who, when,
--     which catalog items, page/size), so "running the report" is traceable.
--
-- Per ADR 003 — versioned hand-authored migration. Plain tables, no RLS;
-- service-role client only. Tenant-scoped via `org_id` (getOrgScopedClient
-- auto-tags inserts / auto-filters reads). PHI: the actual document content
-- lives in object storage / patient_documents under their own ACL — these
-- tables store only types, labels, status, deadlines, and soft pointers.
-- This is an OPERATIONAL deadline/packaging tool, NOT the retired compliance
-- attestation machinery (0156); it does not write resupply.audit_log.

-- ────────────────────────────────────────────────────────────────────
-- 1. claim_adr_requests — the ADR header + deadline + outcome.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."claim_adr_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  -- The claim under review. Nullable so an ADR can be logged from the letter
  -- before the matching claim row is located, then linked. ON DELETE CASCADE.
  "claim_id" uuid
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,

  -- Who is asking, and under what reference.
  "source" text NOT NULL DEFAULT 'other',
  "contractor_name" text,
  "payer_name" text,
  "adr_reference" text,
  -- device  — initial PAP device (E0601) review.
  -- supplies — resupply / accessories review.
  -- both    — combined. Drives the default document checklist.
  "scope" text NOT NULL DEFAULT 'device',

  -- The clock. received_at + response_due come off the ADR letter.
  "received_at" date,
  "response_due" date,
  "received_via" text,
  -- The inbound fax the ADR arrived on (auto/manual link). SET NULL if reaped.
  "received_inbound_fax_id" uuid
    REFERENCES "resupply"."inbound_faxes"("id") ON DELETE SET NULL,

  -- open        — logged, response not started.
  -- in_progress — assembling the packet.
  -- submitted   — packet sent to the contractor (clock stopped).
  -- closed      — outcome recorded.
  "status" text NOT NULL DEFAULT 'open',
  -- pending until the contractor responds.
  "outcome" text NOT NULL DEFAULT 'pending',

  -- Denormalised SLA cache (claimAdrSla in @workspace/resupply-domain). The
  -- worklist orders on response_due and reads this; the sweep recomputes it.
  "sla_status" text NOT NULL DEFAULT 'on_track',

  -- How/when the response went out.
  "submitted_at" timestamp with time zone,
  "submitted_via" text,
  -- Soft pointer to the audit_packets row that was sent (no FK; packets have
  -- their own retention).
  "submitted_packet_id" uuid,

  "notes" text,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "claim_adr_requests_source_chk"
    CHECK ("source" IN (
      'rac', 'cert', 'tpe', 'upic', 'payer_medical_review', 'other'
    )),
  CONSTRAINT "claim_adr_requests_scope_chk"
    CHECK ("scope" IN ('device', 'supplies', 'both')),
  CONSTRAINT "claim_adr_requests_received_via_chk"
    CHECK ("received_via" IS NULL OR "received_via" IN (
      'inbound_fax', 'mail', 'portal', 'email', 'manual'
    )),
  CONSTRAINT "claim_adr_requests_status_chk"
    CHECK ("status" IN ('open', 'in_progress', 'submitted', 'closed')),
  CONSTRAINT "claim_adr_requests_outcome_chk"
    CHECK ("outcome" IN (
      'pending', 'favorable', 'partial', 'unfavorable', 'withdrawn'
    )),
  CONSTRAINT "claim_adr_requests_submitted_via_chk"
    CHECK ("submitted_via" IS NULL OR "submitted_via" IN (
      'fax', 'mail', 'portal'
    )),
  CONSTRAINT "claim_adr_requests_sla_status_chk"
    CHECK ("sla_status" IN ('on_track', 'at_risk', 'overdue', 'decided'))
);
--> statement-breakpoint

-- The worklist: open ADRs, soonest deadline first. Partial so it only carries
-- the still-actionable set.
CREATE INDEX IF NOT EXISTS "claim_adr_requests_worklist_idx"
  ON "resupply"."claim_adr_requests" ("org_id", "response_due")
  WHERE "status" IN ('open', 'in_progress');
--> statement-breakpoint

-- SLA scan for the nightly sweep + the at-risk/overdue buckets.
CREATE INDEX IF NOT EXISTS "claim_adr_requests_sla_idx"
  ON "resupply"."claim_adr_requests" ("org_id", "sla_status", "response_due")
  WHERE "status" IN ('open', 'in_progress');
--> statement-breakpoint

-- A claim → its ADR(s).
CREATE INDEX IF NOT EXISTS "claim_adr_requests_claim_idx"
  ON "resupply"."claim_adr_requests" ("claim_id");
--> statement-breakpoint

-- A patient → their ADR history.
CREATE INDEX IF NOT EXISTS "claim_adr_requests_patient_idx"
  ON "resupply"."claim_adr_requests" ("org_id", "patient_id", "created_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. claim_adr_documents — the response checklist.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."claim_adr_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "adr_id" uuid NOT NULL
    REFERENCES "resupply"."claim_adr_requests"("id") ON DELETE CASCADE,

  -- Catalog key (AUDIT_PACKET_CATALOG, e.g. 'sleep_study'). Intentionally NOT
  -- a DB CHECK enum — the catalog evolves in code; validation happens at the
  -- HTTP boundary against the code-side key set.
  "item_key" text NOT NULL,
  "label" text NOT NULL,

  -- outstanding — still needed.
  -- attached    — satisfied by a stored chart document (document_id).
  -- generated   — satisfied by a system-derived summary (no stored file).
  -- waived      — judged not applicable for this claim (with a reason).
  -- na          — not applicable to this audit's scope.
  "status" text NOT NULL DEFAULT 'outstanding',

  -- Soft pointer to the chart document that satisfies an 'attached' item.
  -- No FK — patient_documents rows are reaped by the retention sweep.
  "document_id" uuid,
  "attached_at" timestamp with time zone,
  "attached_via" text,
  "attached_by_email" text,

  "waived_reason" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "claim_adr_documents_status_chk"
    CHECK ("status" IN (
      'outstanding', 'attached', 'generated', 'waived', 'na'
    )),
  CONSTRAINT "claim_adr_documents_attached_via_chk"
    CHECK ("attached_via" IS NULL OR "attached_via" IN (
      'upload', 'on_file', 'generated', 'inbound_fax', 'manual'
    ))
);
--> statement-breakpoint

-- The checklist for one ADR, in stable order.
CREATE INDEX IF NOT EXISTS "claim_adr_documents_adr_idx"
  ON "resupply"."claim_adr_documents" ("adr_id", "created_at");
--> statement-breakpoint

-- Outstanding-items count for the worklist badge.
CREATE INDEX IF NOT EXISTS "claim_adr_documents_outstanding_idx"
  ON "resupply"."claim_adr_documents" ("adr_id")
  WHERE "status" = 'outstanding';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. audit_packets — a record of each assembled packet PDF.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."audit_packets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- The claim / ADR this packet answers (both optional — a packet can be built
  -- ad hoc). SET NULL so deleting either doesn't erase the build record.
  "claim_id" uuid
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE SET NULL,
  "adr_id" uuid
    REFERENCES "resupply"."claim_adr_requests"("id") ON DELETE SET NULL,

  "scope" text NOT NULL DEFAULT 'device',
  -- The catalog keys included, in print order.
  "selected_items" text[] NOT NULL DEFAULT '{}',
  "item_count" integer NOT NULL DEFAULT 0,
  "page_count" integer,
  "size_bytes" integer,
  -- Where the generated PDF was stored, when persisted (nullable: a packet may
  -- be streamed to the operator without retention).
  "object_key" text,

  "notes" text,
  "generated_by_email" text,
  "generated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "audit_packets_scope_chk"
    CHECK ("scope" IN ('device', 'supplies', 'both'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_packets_patient_idx"
  ON "resupply"."audit_packets" ("org_id", "patient_id", "generated_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_packets_adr_idx"
  ON "resupply"."audit_packets" ("adr_id", "generated_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. Feature flag. Keep in sync with FEATURE_FLAG_KEYS in
--    artifacts/resupply-api/src/lib/feature-flags.ts.
-- ────────────────────────────────────────────────────────────────────
-- Seeded OFF: net-new surface. When OFF, the ADR worklist + nav are hidden,
-- the SLA sweep no-ops, and the audit-packet builder route returns 404/feature
-- disabled. Turning it on lights up an empty queue — it never changes billing.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('billing.adr_queue',
   false,
   'Medicare ADR / audit-response queue + audit-packet builder. When ON, staff can log payer/contractor Additional Documentation Requests against their response deadline, assemble the requested chart documents + generated summaries into one audit-packet PDF, and record the outcome. The nightly SLA sweep (ADR_SLA_SWEEP_CRON) surfaces at-risk/overdue deadlines. When OFF, the queue and builder are hidden and the sweep no-ops.',
   'Billing')
ON CONFLICT (key) DO NOTHING;
