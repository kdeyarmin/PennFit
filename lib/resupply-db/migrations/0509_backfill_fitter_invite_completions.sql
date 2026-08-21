-- 0509_backfill_fitter_invite_completions — repair invites whose fitting
-- was recorded on the clinical session but never on the invite itself.
--
-- Why
-- ---
-- Until this migration's companion change, the ONLY writer of a fitting's
-- result onto `fitter_invites` was the patient's own browser, via
-- POST /shop/fitter-invite/complete — and /results only fired that call
-- when it had a mask to name:
--
--     if (!inviteToken || !measurements || !topPick) return;
--
-- `topPick` is null whenever the clinical engine DECLINES to name one:
-- `contraindicated`, `outside_validated_range`, or a formulary that ruled
-- every candidate out. So for exactly those fittings nothing was
-- transmitted, and the invite stayed at 'opened' forever — no
-- measurements, no `completed_at`, absent from the holding area, the
-- Completed filter, and every count built on them — while a full
-- `fit_sessions` row for the same fitting sat in the review queue.
--
-- To staff that reads as "the invite I sent never registered at all".
--
-- What this does
-- --------------
-- For every invite still sitting in 'sent'/'opened' that HAS a fit
-- session, copy the fitting onto the invite: status, completion time,
-- measurements, answers, and the ranked list (primary first, then the
-- alternatives), plus the `fit_session_id` link when it went unset. The
-- newest session wins where a patient re-scanned.
--
-- Deliberately NOT done here
-- --------------------------
--   * No auto-attach. The live path links a chart on a unique
--     email/phone match, but silently attaching PHI to a chart during a
--     schema migration is the wrong place for that decision. These rows
--     land in the holding area with `patient_id` NULL, which is exactly
--     the queue built for a human to resolve them.
--   * No metering. `fitterFittingsPerMonth` and the Stripe billing-meter
--     event are emitted by the application on a live completion. A
--     backfill must never manufacture billing events for fittings that
--     already happened, so it writes data only.
--   * Nothing touches 'revoked', 'attached', or already-'completed'
--     rows, and 'expired' is left alone too — resurrecting an invite
--     staff have already watched lapse is a judgement call, not a repair.
--
-- Idempotent: the WHERE clause stops matching once a row is completed, so
-- a re-run is a no-op.
--
-- Per ADR 003 — versioned hand-authored migration.

WITH latest_session AS (
  -- One session per invite: the most recent, for a patient who rescanned.
  SELECT DISTINCT ON (fs."fitter_invite_id")
         fs."fitter_invite_id"      AS invite_id,
         fs."id"                    AS session_id,
         fs."created_at"            AS completed_at,
         fs."measurements"          AS measurements,
         fs."profile_answers"       AS profile_answers,
         fs."primary_recommendation" AS primary_recommendation,
         COALESCE(fs."alternatives", '[]'::jsonb) AS alternatives
  FROM resupply."fit_sessions" fs
  WHERE fs."fitter_invite_id" IS NOT NULL
  ORDER BY fs."fitter_invite_id", fs."created_at" DESC
),
ranked AS (
  -- Primary (when there is one) first, then the alternatives, projected
  -- onto the four-value legacy shape the invite's columns speak.
  SELECT ls.invite_id,
         jsonb_agg(
           jsonb_build_object(
             'maskId', c->>'maskSlug',
             'name',   c->>'name',
             'type',   CASE c->>'interfaceType'
                         WHEN 'nasal_pillow' THEN 'nasalPillow'
                         WHEN 'nasal_cradle' THEN 'nasalPillow'
                         WHEN 'hybrid'       THEN 'hybrid'
                         WHEN 'full_face'    THEN 'fullFace'
                         WHEN 'total_face'   THEN 'fullFace'
                         WHEN 'oral'         THEN 'fullFace'
                         ELSE 'nasal'
                       END,
             'confidence', c->'confidence'
           )
           ORDER BY ord
         ) AS recommendations
  FROM latest_session ls
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN ls.primary_recommendation IS NULL THEN '[]'::jsonb
      ELSE jsonb_build_array(ls.primary_recommendation)
    END || ls.alternatives
  ) WITH ORDINALITY AS entry(c, ord)
  GROUP BY ls.invite_id
)
UPDATE resupply."fitter_invites" fi
SET
  "status"       = 'completed',
  "completed_at" = ls.completed_at,
  -- A fitting that reached the engine was necessarily opened; keep the
  -- true first-open time where /resolve recorded one.
  "opened_at"    = COALESCE(fi."opened_at", ls.completed_at),
  "measurements" = COALESCE(fi."measurements", ls.measurements),
  -- The v2 profile is the answers as recorded for these fittings; the
  -- legacy column was simply never written. Only fill a blank.
  "questionnaire_answers" =
    COALESCE(fi."questionnaire_answers", ls.profile_answers),
  -- NULL where the engine named no mask — that IS the result, and the
  -- worklist now renders it as "no mask recommended, a clinician decides".
  "recommended_mask_id"   = ls.primary_recommendation->>'maskSlug',
  "recommended_mask_name" = ls.primary_recommendation->>'name',
  -- The outer guard is load-bearing: `CASE <null> WHEN 'x' … ELSE 'nasal'`
  -- takes the ELSE, so without it a fitting that named NO mask would be
  -- stamped 'nasal' — inventing a mask type for a recommendation that
  -- deliberately does not exist.
  "recommended_mask_type" =
    CASE
      WHEN ls.primary_recommendation IS NULL THEN NULL
      ELSE CASE ls.primary_recommendation->>'interfaceType'
             WHEN 'nasal_pillow' THEN 'nasalPillow'
             WHEN 'nasal_cradle' THEN 'nasalPillow'
             WHEN 'hybrid'       THEN 'hybrid'
             WHEN 'full_face'    THEN 'fullFace'
             WHEN 'total_face'   THEN 'fullFace'
             WHEN 'oral'         THEN 'fullFace'
             ELSE 'nasal'
           END
    END,
  "recommendations" = COALESCE(r.recommendations, fi."recommendations"),
  "fit_session_id"  = COALESCE(fi."fit_session_id", ls.session_id),
  "updated_at"      = now()
FROM latest_session ls
LEFT JOIN ranked r ON r.invite_id = ls.invite_id
WHERE fi."id" = ls.invite_id
  -- Only the exact defect signature: in flight, with a fitting behind it.
  AND fi."status" IN ('sent', 'opened')
  AND fi."completed_at" IS NULL;
