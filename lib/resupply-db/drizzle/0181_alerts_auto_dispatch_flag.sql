-- Feature flag gating automated alert dispatch from server-side events.
--
-- Today the alert library (0179) is admin-send only: a staff member
-- picks an alert + patient + channel in the console. This flag gates
-- the FIRST automated trigger — firing the `payment_failed` alert
-- from the Stripe `invoice.payment_failed` webhook
-- (artifacts/resupply-api/src/lib/stripe/webhook-handler.ts).
--
-- SEEDED DISABLED — CONSENT / BLAST-RADIUS GATE: auto-messaging a
-- patient when a subscription renewal fails is a policy decision
-- (which patients, what wording, how it interacts with the existing
-- past_due dashboard signal). Merging this code must NOT silently
-- start sending; an operator turns the flag on after review. The
-- webhook handler consults isFeatureEnabled("alerts.auto_dispatch")
-- and short-circuits when it's off, so the only behaviour change on
-- deploy is the (still-present) structured WARN log line.
--
-- Keep this key in lockstep with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('alerts.auto_dispatch',
   false,
   'Allow server-side events to automatically send alert-library messages to patients (currently: the payment_failed alert on a Stripe invoice.payment_failed event). Disabled keeps the alert library admin-send only. Review patient-consent and wording before enabling.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;
