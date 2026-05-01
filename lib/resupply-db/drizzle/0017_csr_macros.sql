-- csr_macros — admin-managed canned reply library for the
-- conversation reply composer.
--
-- Why DB-backed instead of hardcoded:
--   The previous baseline was a 6-template TypeScript constant. CSRs
--   asked for the ability to edit / add templates without a code
--   deploy, especially for seasonal patterns ("we're closing early
--   for Thanksgiving", "supply backorder on heated tubing"). Moving
--   the list to a table preserves the "fast pick from a curated set"
--   UX while letting ops own the content.
--
-- Why a separate table from messaging templates:
--   Keep CSR macros isolated from any future system-generated
--   templates (transactional emails, voice IVR prompts). The body
--   here is a free-form text blob with merge tokens; system
--   templates are versioned and tied to a specific event flow.
--
-- Merge token syntax: {{namespace.key}} — see
--   artifacts/resupply-dashboard/src/lib/macro-merge.ts for the
--   supported namespaces. Bodies are stored verbatim and merged
--   client-side at insert time, so the table itself contains no
--   PHI even when bodies reference it.

CREATE TABLE IF NOT EXISTS "resupply"."csr_macros" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  -- short slug like "confirm" or "shipping-eta"; UNIQUE so pickers
  -- can deep-link by slug from a future keyboard-shortcut surface.
  "key" text NOT NULL UNIQUE,
  -- short human label shown in the picker.
  "label" text NOT NULL,
  -- optional category, e.g. "shipping", "rx", "billing". Free-form.
  "category" text,
  -- the canned body itself. Capped at 4KB at the API layer; raw in DB.
  "body" text NOT NULL,
  -- JSON array of channel strings: ["sms"], ["email"], ["sms","email"].
  "channels" jsonb NOT NULL DEFAULT '["sms","email"]'::jsonb,
  -- soft-delete via is_active so analytics + audit see history.
  "is_active" boolean NOT NULL DEFAULT true,
  -- ordering hint for the picker; lower = earlier.
  "sort_order" integer NOT NULL DEFAULT 100,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" text,
  "updated_by" text
);

-- Picker query: active macros, ordered by sort_order then label.
CREATE INDEX IF NOT EXISTS "csr_macros_active_sort_idx"
  ON "resupply"."csr_macros" ("is_active", "sort_order", "label")
  WHERE "is_active" = true;

-- Seed the historical templates so existing CSR muscle memory keeps
-- working post-deploy. The seeds use the new {{patient.firstName}}
-- syntax; the legacy {firstName} renderer in
-- artifacts/resupply-dashboard/src/lib/reply-templates.ts is
-- preserved as a fallback for callers that haven't migrated yet.
INSERT INTO "resupply"."csr_macros"
  ("key", "label", "category", "body", "channels", "sort_order")
VALUES
  (
    'confirm',
    'Confirm — order placed',
    'Confirmation',
    E'Hi {{patient.firstName}}, thanks for confirming! We''ll get your resupply order out the door this week. Reply STOP to opt out.',
    '["sms","email"]'::jsonb,
    10
  ),
  (
    'decline',
    'Acknowledge decline',
    'Confirmation',
    E'Got it, {{patient.firstName}} — we''ll skip this cycle and reach out at your next refill window. Let us know if anything changes.',
    '["sms","email"]'::jsonb,
    20
  ),
  (
    'need-rx',
    'Need updated prescription',
    'Prescription',
    E'Hi {{patient.firstName}}, before we can ship your resupply we need an updated prescription on file. Could you ask your provider to fax or email it to us? Thanks!',
    '["sms","email"]'::jsonb,
    30
  ),
  (
    'shipping-eta',
    'Shipping ETA — 3-5 days',
    'Shipping',
    E'Hi {{patient.firstName}}, your order is in the queue. Standard shipping takes 3-5 business days. We''ll send a tracking link once it''s out.',
    '["sms","email"]'::jsonb,
    40
  ),
  (
    'address-check',
    'Confirm shipping address',
    'Shipping',
    E'Hi {{patient.firstName}}, can you confirm we should ship to the address we have on file? If anything''s changed, just reply with the new one.',
    '["sms","email"]'::jsonb,
    50
  ),
  (
    'callback',
    'Offer phone callback',
    'Outreach',
    E'Hi {{patient.firstName}}, easier to talk through it? Reply with a good time and we''ll give you a quick call.',
    '["sms"]'::jsonb,
    60
  )
ON CONFLICT ("key") DO NOTHING;
