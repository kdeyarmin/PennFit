-- 0377_seed_pennpaps_email_sender — give the Penn Home Medical Supply tenant
-- its OWN explicit From identity, decoupling it from the platform default.
--
-- Brand architecture: the platform is CareMetric Breathe (cmbreathe.com); Penn
-- Home Medical Supply (storefront brand "PennPaps", pennpaps.com) is one
-- tenant. The per-tenant sender (organizations.from_email / from_name, 0360)
-- overrides the platform default `SENDGRID_FROM_EMAIL`; a NULL column falls
-- back to that platform default.
--
-- Historically `SENDGRID_FROM_EMAIL` is `info@pennpaps.com` and the seed org's
-- from_email was left NULL, so PennPaps mail went out from pennpaps.com only
-- BECAUSE the platform default happened to be a pennpaps.com address. That
-- conflates the two layers: once the platform default is moved to a
-- cmbreathe.com address (the correct platform identity), an unconfigured
-- tenant — including a future tenant #2 — would otherwise inherit
-- PennPaps' address. Setting the seed tenant's sender explicitly fixes this:
-- PennPaps always sends from pennpaps.com, and the platform default is free to
-- become cmbreathe.com for everyone else.
--
-- Deliverability note: pennpaps.com must stay authenticated (SPF/DKIM) in
-- SendGrid for this From to land in the inbox — it already is (this address
-- was the platform default), so storing it here changes attribution, not
-- deliverability.
--
-- Fill-only + idempotent: COALESCE never overwrites a value an operator has
-- since set, and re-running is a no-op.

UPDATE "resupply"."organizations"
SET
  "from_email" = COALESCE("from_email", 'info@pennpaps.com'),
  "from_name" = COALESCE("from_name", 'Penn Home Medical Supply')
WHERE "slug" = 'penn-home-medical';
