-- 0506_penn_pilot_full_access — give the Penn Home Medical Supply tenant
-- (the pilot account) every SHIPPED feature in the catalog.
--
-- Why
-- ---
-- Penn Home Medical Supply is the pilot tenant. The intent is that every
-- feature that actually does something is available to them, so the pilot
-- exercises the whole product rather than a subset.
--
-- Penn already carries 85 of the 87 catalog flags ON. This closes the one
-- remaining gap that is a REAL, shipped feature, and deliberately leaves
-- the other one alone. Scoped to Penn by slug — no other tenant's flags,
-- and no platform default, changes here.
--
-- (1) collections.agency_export — TURNED ON.
--     Seeded OFF by 0461 alongside collections.dunning, because both are
--     net-new patient-facing outreach with TCPA exposure. Penn already has
--     collections.dunning ON, which means the dunning ladder escalates
--     unpaid balances all the way to the 'agency' step — and then parks
--     the run there with no way to act on it, because
--     GET /admin/billing/collections/agency-export 404s while this flag is
--     OFF (routes/admin/collections-worklist.ts checks BOTH flags). So the
--     tenant that runs the ladder cannot complete it. Turning this on
--     restores the last step of a workflow they are already running.
--
--     This does NOT send anything to a collections agency. The flag only
--     un-hides a reviewed, deliberate CSV export (formula-injection
--     guarded) of runs that already reached the agency step.
--
-- (2) domains.tls_automation — DELIBERATELY LEFT OFF.
--     Not a gap. This is a feature-gate seeded ahead of its
--     implementation (0347), and 0503 restamped its description to say so
--     ("NOT YET ACTIVE in this build"). There is no consumer of the key
--     anywhere in the codebase — turning it on for Penn would light up a
--     Control Center switch that does nothing, which is worse for a pilot
--     operator than an honest OFF. It flips ON in the migration that
--     actually ships Cloudflare-for-SaaS TLS automation, not here.
--     Penn's custom domain (pennpaps.com) is fronted by Cloudflare and
--     terminates TLS today regardless of this flag.
--
-- Idempotent: keyed UPDATE, safe to re-run. Per ADR 003 — versioned
-- hand-authored migration.

UPDATE "resupply"."feature_flags" AS ff
SET "enabled" = true,
    "updated_at" = now()
FROM "resupply"."organizations" AS o
WHERE o."id" = ff."org_id"
  AND o."slug" = 'penn-home-medical'
  AND ff."key" = 'collections.agency_export'
  AND ff."enabled" IS DISTINCT FROM true;
