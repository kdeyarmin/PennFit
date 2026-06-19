-- 0396_fix_platform_outreach_trigger_guards — Idempotency fix for the
-- three updated_at triggers introduced by 0394_platform_outreach_email.
--
-- Migration 0394 created these triggers without guards; if that migration is
-- ever re-applied on a DB where the triggers already exist (e.g. a replay in
-- a new environment seeded from a snapshot) the CREATE TRIGGER statements
-- fail. This corrective migration drops each trigger before recreating it,
-- making the result idempotent.

DROP TRIGGER IF EXISTS "platform_contacts_updated_at_trigger" ON "resupply"."platform_contacts";
CREATE TRIGGER "platform_contacts_updated_at_trigger"
  BEFORE UPDATE ON "resupply"."platform_contacts"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."set_platform_contacts_updated_at"();

DROP TRIGGER IF EXISTS "platform_email_campaigns_updated_at_trigger" ON "resupply"."platform_email_campaigns";
CREATE TRIGGER "platform_email_campaigns_updated_at_trigger"
  BEFORE UPDATE ON "resupply"."platform_email_campaigns"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."set_platform_email_campaigns_updated_at"();

DROP TRIGGER IF EXISTS "platform_email_recipients_updated_at_trigger" ON "resupply"."platform_email_recipients";
CREATE TRIGGER "platform_email_recipients_updated_at_trigger"
  BEFORE UPDATE ON "resupply"."platform_email_recipients"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."set_platform_email_recipients_updated_at"();
