-- 0525_retire_shop_from_default_tagline — insurance-only storefront strapline.
--
-- Why
-- ---
-- Migration 0346 seeded organizations.tagline to
-- "Your CPAP, made simple. Fit. Shop. Resupply." Patients no longer shop
-- or pay by card — supplies go through insurance — so the default strapline
-- still advertising "Shop" is wrong on every tenant that never customized
-- it (including the seed Penn Home Medical Supply row on pennpaps.com).
--
-- Scope
-- -----
-- Only rewrite rows that still carry the EXACT 0346 default. A tenant that
-- typed their own tagline is left alone.
--
-- Idempotent: re-running the UPDATE finds zero matching rows.
-- Per ADR 003 — versioned hand-authored migration. No journal append.

UPDATE "resupply"."organizations"
SET
  "tagline" = 'Your CPAP, made simple. Fit. Order. Resupply.',
  "updated_at" = NOW()
WHERE "tagline" = 'Your CPAP, made simple. Fit. Shop. Resupply.';
