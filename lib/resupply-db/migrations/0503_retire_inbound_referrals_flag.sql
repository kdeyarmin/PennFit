-- 0503_retire_inbound_referrals_flag — retire the vestigial
-- inbound_referrals.dispatcher feature flag, and stop the two staged
-- (not-yet-implemented) flags from describing themselves as live.
--
-- (1) inbound_referrals.dispatcher (seeded ON in 0218) was the runtime
--     kill switch for the three inbound DME-order referral worker jobs
--     (Parachute + EHR-FHIR). Commit 4cfdb5a3 (2026-06-05) removed that
--     entire subsystem — the jobs, routes, packages, admin UI, and the
--     RESUPPLY_INBOUND_REFERRALS_ENABLED env gate — but left this flag
--     behind: a Control Center toggle wired to nothing. The key is
--     removed from FEATURE_FLAG_KEYS and the preset bundles in the same
--     change, so without this DELETE the row would list forever as an
--     unmanageable ghost (the list endpoint reads DB rows; PATCH
--     validates against the enum). Bounded destructive statement: exact
--     key match, all orgs. Re-running it is a no-op (0 rows) — nothing
--     re-seeds the key.
--
-- (2) domains.tls_automation (0347) and fitter.multiframe_capture (0485)
--     are DELIBERATE feature-gates seeded ahead of their implementations
--     (Cloudflare-for-SaaS TLS automation; guided multi-angle capture).
--     They stay — but their descriptions read as if the features were
--     live, so an operator toggling them today gets silently nothing.
--     Prefix each description with an explicit "Not yet active" notice.
--     The migrations that SHIP those features must update the
--     descriptions again (a new migration — this file is immutable, M1).
--
-- Per ADR 003 — versioned hand-authored migration.

DELETE FROM "resupply"."feature_flags"
WHERE "key" = 'inbound_referrals.dispatcher';
--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "description" =
  'NOT YET ACTIVE in this build — the TLS automation has not shipped, so '
  || 'this toggle currently has no effect. When it lands: automatically '
  || 'provision + renew TLS for tenant custom domains via Cloudflare for '
  || 'SaaS (Custom Hostnames) when a domain is verified. Requires '
  || 'CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID. Off = manual operator '
  || 'edge binding.'
WHERE "key" = 'domains.tls_automation';
--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "description" =
  'NOT YET ACTIVE in this build — capture is single-frame today, so this '
  || 'toggle currently has no effect. When it lands: guided multi-angle '
  || 'scan capture with live quality checks (lighting, distance, head '
  || 'position, obstruction, movement) and cross-frame measurement '
  || 'agreement, producing a measurement confidence score instead of a '
  || 'single unverified snapshot. OFF will keep single-frame capture.'
WHERE "key" = 'fitter.multiframe_capture';
