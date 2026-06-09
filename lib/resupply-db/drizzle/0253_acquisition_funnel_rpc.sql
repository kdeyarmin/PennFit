-- 0253_acquisition_funnel_rpc — server-side rollup of the anonymous
-- storefront/fitter funnel events (Growth #G1, surfacing half).
--
-- Background: the customer SPA already instruments the whole acquisition
-- funnel — `lib/track.ts` posts ~25 typed steps to /api/usage-events, which
-- persists them into public.usage_events (mig 0027). But NOTHING ever read
-- that table: the events were captured and never surfaced, so the team
-- could not see where patients drop out of the fitter/checkout funnel.
-- This function is the read side: per-step distinct-session + raw-event
-- counts over a time window, computed in Postgres so the route receives
-- one small row per step (never the whole event firehose).
--
-- `usage_events` is anonymous by construction (session_id is a per-tab
-- random id; no patient identity, IP, or user-agent is stored — see the
-- ingest route), so this rollup carries no PHI.
--
-- Follows the established RPC pattern (0228 / 0229): SECURITY DEFINER +
-- pinned search_path + GRANT to service_role only, STABLE.
--
-- Per ADR 003 — versioned hand-authored migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Index the column we filter on so the window scan stays cheap as the
-- event table grows. IF NOT EXISTS keeps the migration idempotent.
CREATE INDEX IF NOT EXISTS usage_events_occurred_at_idx
  ON public.usage_events (occurred_at);
--> statement-breakpoint

-- Declared in the `resupply` schema (where every other RPC lives, and the
-- only non-public schema exposed to PostgREST) even though it reads the
-- public.usage_events table — callers reach it via `.schema("resupply")`
-- like the rest of the RPC surface. The fully-qualified table reference +
-- pinned search_path keep it unambiguous.
CREATE OR REPLACE FUNCTION resupply.acquisition_funnel_steps(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  step text,
  sessions bigint,
  events bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, public, pg_catalog
AS $$
  SELECT
    ue.step,
    COUNT(DISTINCT ue.session_id) AS sessions,
    COUNT(*) AS events
  FROM public.usage_events ue
  WHERE ue.occurred_at >= p_from
    AND ue.occurred_at <= p_to
  GROUP BY ue.step
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.acquisition_funnel_steps(timestamptz, timestamptz) TO service_role;
