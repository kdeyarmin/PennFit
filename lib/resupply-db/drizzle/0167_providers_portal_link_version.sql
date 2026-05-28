-- Add a monotonically-increasing version counter to providers so
-- provider-portal tokens can be revoked without a separate
-- revocation table.
--
-- A token's payload now embeds the provider's `portal_link_version`
-- at mint time. The verifier rejects any token whose embedded
-- version is lower than the row's current value. To "revoke" all
-- outstanding tokens for a provider, increment the column.
--
-- Existing tokens (minted before this migration) carry no `v`
-- field; the verifier treats them as version 0, which matches the
-- default DEFAULT 0 below. To force-revoke all pre-migration
-- tokens, run `UPDATE providers SET portal_link_version = 1` after
-- this migration applies.

ALTER TABLE "resupply"."providers"
  ADD COLUMN IF NOT EXISTS "portal_link_version" integer NOT NULL DEFAULT 0;
