-- shop_customer_push_subscriptions — W3C Web Push subscription
-- registry per shop customer (Phase C.1 / feature #4).
--
-- Each row is one browser-tab-pair-keys-per-device. A customer can
-- have multiple rows (laptop + phone, or multiple browsers on the
-- same device). The dispatcher fans out across all rows on send.
--
-- Schema notes:
--   * `endpoint` is the push service URL Mozilla / Apple / Google
--     gave the subscriber. Unique per row (one row per endpoint —
--     re-subscribing with the same endpoint should overwrite, not
--     duplicate).
--   * `auth_b64` and `p256dh_b64` are the public encryption keys
--     the push service expects on send; stored base64-url encoded
--     verbatim from the PushSubscription.toJSON() output.
--   * `user_agent` is informational (CSR can recognize the device
--     in the audit log if a customer asks "where am I subscribed
--     from").
--   * No FK to shop_customers — same rationale as the comm-prefs
--     blob: rows can predate the row-creation in shop_customers
--     during sign-up race conditions.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."shop_customer_push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" text NOT NULL,
  "endpoint" text NOT NULL UNIQUE,
  "auth_b64" text NOT NULL,
  "p256dh_b64" text NOT NULL,
  "user_agent" text,
  -- Set to NOW() when the dispatcher catches a 410 / 404 from the
  -- push service (browser permission revoked). The next dispatcher
  -- run filters these out so we don't waste sends.
  "expired_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Customer's active subscriptions: drives the dispatcher fanout.
CREATE INDEX IF NOT EXISTS "shop_customer_push_subscriptions_active_idx"
  ON "resupply"."shop_customer_push_subscriptions" ("customer_id")
  WHERE "expired_at" IS NULL;
