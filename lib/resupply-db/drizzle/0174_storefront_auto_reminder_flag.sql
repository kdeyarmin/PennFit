-- 0174_storefront_auto_reminder_flag — feature flag for auto-enrolling
-- cash-pay storefront buyers into replacement reminders (#4).
--
-- The storefront (cash-pay) and insurance resupply pipelines are
-- deliberately separate — we do NOT create insurance episodes from a
-- cash-pay sale. This bridge instead enrolls a paid order's buyer in
-- the existing public.reminder_subscriptions system (the same one the
-- /reminders opt-in uses), seeded with the consumables they bought at
-- the standard replacement cadence.
--
-- SEEDED DISABLED — CONSENT GATE: auto-enrolling a buyer into recurring
-- reminder emails is a consent decision (CAN-SPAM / practice policy).
-- Production starts with it OFF; an operator turns it on after a
-- consent review. The reminder system is email-only and every
-- subscription carries a manage/unsubscribe token, and the enroller
-- never re-subscribes an email that previously unsubscribed.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('storefront.auto_reminder_enrollment',
   false,
   'On a paid storefront order, auto-enroll the buyer in replacement reminders for the consumables they purchased (mask/cushion/tubing/filter/etc.) at the standard cadence. Email-only, with a manage/unsubscribe token; never re-enrolls a prior unsubscribe. Disabled keeps reminder enrollment to the explicit /reminders opt-in. Review consent before enabling.',
   'Storefront')
ON CONFLICT (key) DO NOTHING;
