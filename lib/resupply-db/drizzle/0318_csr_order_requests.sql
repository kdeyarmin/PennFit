-- 0318_csr_order_requests — CSR-created "sign & pay" orders.
--
-- A CSR builds an order from the admin Orders page (free-form line
-- items priced in cents), optionally attaches paperwork documents
-- (snapshotted from the patient-packet template catalog), and sends
-- the customer a signed HMAC link. On the public page the customer
-- reviews the order, e-signs the paperwork, then pays through Stripe
-- Hosted Checkout. The Checkout Session is mirrored into
-- resupply.shop_orders exactly like /shop/checkout, so the existing
-- charge webhook flips it to paid and the normal fulfillment
-- lifecycle (tracking / delivered / refund) applies. Payment state is
-- therefore DERIVED at read time by joining stripe_session_id onto
-- shop_orders — this table's own `status` only tracks the link
-- lifecycle (sent → viewed → signed, or canceled).
--
-- Signature posture mirrors patient_packet_signatures: typed-or-drawn
-- PNG data URL persisted (never logged), signer IP + user agent
-- recorded, ESIGN consent required. `documents` holds the send-time
-- content snapshot (token-form sections) so later template edits never
-- rewrite an already-sent order.

CREATE TABLE IF NOT EXISTS resupply.csr_order_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_reference text NOT NULL UNIQUE,
  -- Link lifecycle only: 'sent' | 'viewed' | 'signed' | 'canceled'.
  status text NOT NULL DEFAULT 'sent',
  customer_name text NOT NULL,
  customer_email text,
  customer_phone text,
  -- [{ description, quantity, unitAmountCents }] — validated at the route.
  items jsonb NOT NULL,
  amount_total_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  note_to_customer text,
  -- [{ key, title, category, requiresSignature, version, sections }] —
  -- send-time snapshot from the patient-packet template catalog.
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Bumping invalidates every outstanding signing link (same model as
  -- patient_packets.link_version).
  link_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  -- Signature capture (set together when the customer signs).
  signed_at timestamptz,
  signer_name text,
  signature_image text,
  signer_ip text,
  signer_user_agent text,
  consent_esign boolean,
  canceled_at timestamptz,
  canceled_by_email text,
  -- The most recent Stripe Checkout Session minted for this order;
  -- joins onto resupply.shop_orders.stripe_session_id for payment state.
  stripe_session_id text,
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS csr_order_requests_created_at_idx
  ON resupply.csr_order_requests (created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS csr_order_requests_status_idx
  ON resupply.csr_order_requests (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS csr_order_requests_stripe_session_idx
  ON resupply.csr_order_requests (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
