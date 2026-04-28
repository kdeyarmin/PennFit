-- idempotency_keys — replay protection for admin write endpoints.
-- See lib/resupply-db/src/schema/idempotency-keys.ts for design rationale.
--
-- Composite PK (user_id, endpoint, key) lets two admins use the same
-- opaque key value without colliding, and lets the same admin reuse a
-- key across different endpoints without it being treated as a replay.
-- request_hash holds sha256(stable_json(body)) so PHI never lands
-- here in plaintext. response_body is jsonb so a replay returns
-- byte-identical JSON to the caller. expires_at is 24h after
-- creation; expired rows are overwritten on the next conflicting
-- INSERT (the middleware uses ON CONFLICT DO UPDATE).
CREATE TABLE "resupply"."idempotency_keys" (
"user_id" text NOT NULL,
"endpoint" text NOT NULL,
"key" text NOT NULL,
"request_hash" "bytea" NOT NULL,
"response_status" integer NOT NULL,
"response_body" jsonb NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"expires_at" timestamp with time zone NOT NULL,
CONSTRAINT "idempotency_keys_user_id_endpoint_key_pk" PRIMARY KEY("user_id","endpoint","key")
);
--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "resupply"."idempotency_keys" USING btree ("expires_at");
