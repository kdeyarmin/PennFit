-- 0249_billing_line_ordering_provider_flag — feature flag for the
-- line-level ordering-provider loop (837P 2420E NM1*DK).
--
-- The 837P builder can emit a line-level ordering provider (the
-- DMEPOS-strict placement of the prescribing physician, so Medicare's
-- PECOS edit binds at the line) in ADDITION to the existing claim-level
-- 2310D referring loop. When this flag is ON,
-- office-ally-batch.buildOneDetail attaches the claim's referring
-- provider (the prescriber) — with NPI + practice address — to every
-- service line as loop 2420E.
--
-- SEEDED DISABLED on purpose: turning it on CHANGES the live 837P (adds a
-- loop), and whether a given payer wants the line-level ordering provider
-- (vs. the claim-level referring loop alone, or instead of it) is exactly
-- the kind of thing that must be confirmed against a live 277CA
-- acknowledgment before billing production. The recommended activation is
-- to flip it on during the Office Ally usage-indicator=T (test) cycle,
-- submit a batch, and confirm the 277CA accepts it; then leave it on for
-- production. Off → byte-identical 837P output.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('billing.line_ordering_provider',
   false,
   'Emit the line-level ordering-provider loop (837P 2420E NM1*DK) on each claim line, sourced from the claim''s referring (prescribing) provider. DMEPOS-strict placement so Medicare''s PECOS edit binds at the line; additive to the claim-level 2310D referring loop. SEEDED OFF — turning it on changes the live 837P, so validate against a live 277CA in the Office Ally test (T) cycle first.',
   'Billing')
ON CONFLICT (key) DO NOTHING;
