-- 0314: customer-support contact fields on the dme_organization
-- singleton.
--
-- The organization row already carries the billing/legal identity
-- (legal name, NPI, PTAN, billing email, main phone). The storefront,
-- chatbots, and patient-facing documents additionally surface a
-- customer-support line that may differ from the main business phone
-- (e.g. a dedicated support mailbox and published hours). These three
-- nullable columns let the admin "Company information" page own those
-- values too; every reader falls back to the main phone/email when
-- they are NULL, so existing rows need no backfill.

ALTER TABLE "resupply"."dme_organization"
  ADD COLUMN IF NOT EXISTS "support_email" varchar(180) NULL,
  ADD COLUMN IF NOT EXISTS "support_phone_e164" varchar(20) NULL,
  ADD COLUMN IF NOT EXISTS "support_hours_text" varchar(160) NULL;

-- Same shape constraints the existing contact columns use (0132).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dme_organization_support_phone_e164_check'
  ) THEN
    ALTER TABLE "resupply"."dme_organization"
      ADD CONSTRAINT "dme_organization_support_phone_e164_check"
      CHECK (
        "support_phone_e164" IS NULL
        OR "support_phone_e164" ~ '^\+[1-9][0-9]{1,14}$'
      );
  END IF;
END $$;
