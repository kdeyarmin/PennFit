-- 0425_fax_voice_usage_metered — per-unit usage billing for the fax and AI
-- voice premium features.
--
-- The fax_automation ($199/mo) and ai_voice_agent ($499/mo) add-ons are FLAT
-- enablement features whose catalog notes already say usage is "billed
-- separately" / "carrier costs pass through". This adds the usage side as two
-- companion METERED add-ons that bill per unit ON TOP of the flat feature:
--   * voice_usage — $0.50 per completed call  (metric aiVoiceEvents)
--   * fax_usage   — $0.10 per outbound fax     (metric faxEvents)
--
-- Neither metric has a plan allowance, so `included_units` is NULL → every
-- event is billable (no free tier). The companion add-on rides on its parent
-- feature: the subscription sync attaches it whenever the tenant has an
-- active add-on sharing its `usage_metric` (fax_automation / ai_voice_agent).
--
-- GATED + reversible like the other standard overage add-ons: the app only
-- bills these as metered when PLATFORM_METERED_OVERAGE_ENABLED is set. With
-- the flag unset (the default) they are inert — no metered price, no meter
-- events — so applying this migration changes nothing about how any tenant
-- bills until an operator enables + validates it
-- (docs/runbooks/stripe-metered-billing-validation.md).

INSERT INTO "resupply"."billing_addons"
  ("code", "name", "category", "description", "recurring_price_cents",
   "one_time_min_cents", "one_time_max_cents", "unit_label", "usage_metric",
   "pass_through_note", "sort_order", "usage_type",
   "metered_unit_amount_decimal", "meter_event_name")
VALUES
  ('voice_usage', 'AI voice usage', 'usage',
   'Per-completed-call usage for the AI voice agent, billed in addition to the flat AI voice agent feature.',
   50, NULL, NULL, 'per completed call', 'aiVoiceEvents',
   'Billed per completed call while the AI voice agent add-on is active.', 81,
   'metered', '50', 'voice_call_usage'),
  ('fax_usage', 'Fax usage', 'usage',
   'Per-outbound-fax usage for fax automation, billed in addition to the flat fax automation feature.',
   10, NULL, NULL, 'per outbound fax', 'faxEvents',
   'Billed per outbound fax while the fax automation add-on is active.', 101,
   'metered', '10', 'fax_usage')
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "recurring_price_cents" = EXCLUDED."recurring_price_cents",
  "unit_label" = EXCLUDED."unit_label",
  "usage_metric" = EXCLUDED."usage_metric",
  "pass_through_note" = EXCLUDED."pass_through_note",
  "sort_order" = EXCLUDED."sort_order",
  "usage_type" = EXCLUDED."usage_type",
  "metered_unit_amount_decimal" = EXCLUDED."metered_unit_amount_decimal",
  "meter_event_name" = EXCLUDED."meter_event_name",
  "updated_at" = now();
