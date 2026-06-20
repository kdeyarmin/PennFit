-- 0368_org_fax_identity — per-tenant fax number identity + provisioning.
--
-- Companion to 0364 (per-tenant SMS / voice identity). Each DME tenant
-- gets its OWN fax number so inbound faxes (sleep studies, signed Rx,
-- chart notes) route to the right tenant and outbound faxes (physician
-- outreach, appeal letters) send from the tenant's own DID.
--
-- Twilio retired Programmable Fax, so the number is provisioned through
-- Telnyx (the same vendor that already SENDS/RECEIVES our faxes — see
-- lib/resupply-telecom/src/telnyx-fax.ts). The tenant:onboard
-- `--provision-fax` step and the admin "Fax number" settings page order a
-- fax-capable DID from Telnyx and write it here.
--
--   * fax_from_number    — the tenant's fax DID (E.164). NULL → the tenant
--     has no provisioned fax number yet; fax SEND falls back to the
--     platform TELNYX_FAX_FROM_NUMBER, and inbound fax routing falls back
--     to the seed tenant (unchanged single-tenant behavior).
--   * fax_telnyx_order_id — the Telnyx number-order id (UUID) the DID came
--     from, kept for audit / reconciliation. NULL for a manually-entered
--     (ported / pre-existing) number.
--   * fax_provisioned_at — when the number was attached to the tenant.
--
-- ADDITIVE and inert by default: all three columns are nullable with no
-- default, and the seed tenant (Penn Home Medical Supply) leaves them NULL
-- so its faxing continues on the platform number until an operator
-- provisions one.
--
-- The unique partial index supports the inbound-fax reverse lookup
-- (resolve `org_id` from the called fax number), excluding the common NULL
-- rows. A given fax number routes to exactly one tenant.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "fax_from_number" text,
  ADD COLUMN IF NOT EXISTS "fax_telnyx_order_id" text,
  ADD COLUMN IF NOT EXISTS "fax_provisioned_at" timestamptz;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_fax_from_number_key"
  ON "resupply"."organizations" ("fax_from_number")
  WHERE "fax_from_number" IS NOT NULL;
