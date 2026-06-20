-- patient_therapy_links — durable per-patient mapping between a
-- PennFit patient and their therapy-cloud (ResMed AirView, Philips
-- Care, etc) account so the nightly sync worker doesn't need a
-- human to re-enter `partnerPatientId` on every run. Phase E.1
-- groundwork for the upcoming therapy-nights auto-sync job.
--
-- One row per (patient, source). A patient may have at most one
-- *active* link per source (enforced via a partial unique index
-- below); historical 'revoked' rows are kept for audit.
--
-- The companion `patient_therapy_nights` table (migration 0046)
-- already carries `source` on every row, so this table is the
-- write-side identity map and intentionally does not duplicate
-- night data here.
--
-- PHI posture: partner patient ids and device serials are PHI
-- adjacent (they map back to a real patient at the partner). They
-- live in plaintext per the post-0025 policy (no column-level
-- encryption); confidentiality relies on TLS in flight + Postgres
-- at-rest encryption + admin-only read scope on every endpoint.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_therapy_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Same value space as patient_therapy_nights.source minus 'manual'
  -- (manual uploads have no remote account to link to).
  "source" text NOT NULL,
  -- The id the partner uses for this patient. Some partners
  -- (ResMed) use a numeric id; others (Philips) use a GUID. We
  -- store as text and validate at the application boundary.
  "partner_patient_id" text NOT NULL,
  -- Optional device serial when the partner exposes it. Useful
  -- for support when a patient swaps machines.
  "device_serial" text,
  -- Lifecycle: 'active' rows are pulled by the nightly worker;
  -- 'paused' rows are skipped without complaint; 'revoked' rows
  -- are tombstoned for audit (we can re-link without losing
  -- history of when the original link was set up).
  "status" text NOT NULL DEFAULT 'active',
  -- Last-sync bookkeeping populated by the worker. Never PHI —
  -- last_sync_error is a short status string ('auth_failed',
  -- 'not_found', 'rate_limited', 'unknown_error'); we deliberately
  -- do not stash partner response bodies here.
  "last_synced_at" timestamp with time zone,
  "last_sync_status" text,
  "last_sync_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_therapy_links_source_enum"
    CHECK ("source" IN ('resmed_airview', 'philips_care')),
  CONSTRAINT "patient_therapy_links_status_enum"
    CHECK ("status" IN ('active', 'paused', 'revoked')),
  -- A single partner-side id maps to at most one PennFit patient.
  -- (If a clinic re-uses a partner id across patients, that's a
  -- partner-side data error we want to surface — fail at link
  -- create rather than silently fan out night data.)
  CONSTRAINT "patient_therapy_links_partner_unique"
    UNIQUE ("source", "partner_patient_id")
);

-- A patient can only have one *active* link per source. Historical
-- 'paused' / 'revoked' rows for the same (patient, source) are
-- allowed so that "I cancelled and re-linked AirView" leaves an
-- audit trail rather than overwriting in place.
CREATE UNIQUE INDEX IF NOT EXISTS "patient_therapy_links_active_unique"
  ON "resupply"."patient_therapy_links" ("patient_id", "source")
  WHERE "status" = 'active';

-- Common admin lookup path: list all links for one patient across all
-- statuses.
CREATE INDEX IF NOT EXISTS "patient_therapy_links_patient_idx"
  ON "resupply"."patient_therapy_links" ("patient_id");

-- Worker scan index: "give me the active links most overdue for a
-- sync." NULLs sort first by Postgres default — exactly what we
-- want for never-synced rows.
CREATE INDEX IF NOT EXISTS "patient_therapy_links_scan_idx"
  ON "resupply"."patient_therapy_links" ("status", "last_synced_at");
