-- 0359_org_email_sender — per-tenant outbound email From identity (G6).
--
-- Phase 2 relaxes the "one From address" invariant (info@pennpaps.com,
-- ADR 016/018) into "one From address PER TENANT". Every email still
-- funnels through the shared `createSendgridClient()` — which already
-- accepts a `fromEmail` / `fromName` override — so this is a deliberate,
-- documented relaxation, NOT a bypass of the shared client.
--
--   * from_email — the tenant's verified sender address. NULL means "use
--     the platform default" (`SENDGRID_FROM_EMAIL`, falling back to the
--     `info@pennpaps.com` constant) → current behavior, unchanged.
--   * from_name  — the tenant's sender display name (optional). NULL →
--     platform default (`SENDGRID_FROM_NAME`).
--
-- ADDITIVE and inert by default: both columns are nullable with no
-- default, and the seed tenant (Penn Home Medical Supply) leaves them NULL
-- so its mail continues to send from info@pennpaps.com. A tenant only
-- sends under its own identity once an operator populates `from_email`
-- AND its sending domain is authenticated in SendGrid (an external,
-- per-tenant setup step that is NOT enforced here).
--
-- NOTE: deliverability requires the address's DOMAIN to be authenticated
-- in SendGrid (SPF/DKIM). Storing an unauthenticated `from_email` will
-- send but land in spam — the operator runbook (and a later admin UI)
-- must gate enabling a tenant sender on domain authentication. The column
-- is the data substrate; the resolver fails soft to the platform default.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "from_email" text,
  ADD COLUMN IF NOT EXISTS "from_name" text;
