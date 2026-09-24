-- Business-line text requests are platform-global, like sales_leads (0402).
-- One bundled follow-up per inbound call. Claim BEFORE contacting Twilio:
-- reconnects, duplicate tool calls and ambiguous network errors cannot resend.
CREATE TABLE IF NOT EXISTS resupply.shared_phone_sms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_call_sid text NOT NULL UNIQUE,
  recipient text NOT NULL CHECK (recipient ~ '^\+1[2-9][0-9]{9}$'),
  resources jsonb NOT NULL,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  twilio_message_sid text UNIQUE,
  delivery_status text NOT NULL DEFAULT 'submitting'
    CHECK (delivery_status IN ('submitting', 'accepted', 'delivered', 'failed', 'undelivered', 'unknown')),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE resupply.shared_phone_sms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON resupply.shared_phone_sms FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON resupply.shared_phone_sms TO service_role;
