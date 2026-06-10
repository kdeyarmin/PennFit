-- Outreach playbooks — situation-based contact templates (cadence +
-- wording) for SMS / email / phone-call outreach to patients.
--
-- Why
-- ---
-- Staff kept re-deciding, per patient, WHEN to reach out, on WHICH
-- channel, and WHAT to say. The automated dispatchers (resupply
-- reminders, fitter campaign, smart triggers) cover their own slices,
-- but the everyday CSR moments — "this patient used the fitter and
-- went quiet", "this patient is missing compliance goals", "this
-- patient is due to re-order" — had no reusable recipe. A playbook
-- bundles the whole recipe: the situation it's for, a multi-touch
-- cadence (day offsets), the channel per touch, and editable wording
-- templates ({{first_name}} / {{practice_name}} substitution).
--
-- Model
-- -----
--   outreach_playbooks       — the library entry (situation + name).
--   outreach_playbook_steps  — ordered touches: day offset + channel
--                              + wording. Email steps carry a subject;
--                              call steps carry a staff call script.
--   outreach_playbook_runs   — one row per (playbook, patient) start.
--                              The dispatcher walks next_step_index /
--                              next_step_at exactly like the fitter
--                              campaign walks its touch counter.
--   outreach_playbook_step_log — per-touch outcome trail. Call steps
--                              land here as status='call_due' and form
--                              the staff call queue (completed via the
--                              admin UI with a disposition outcome).
--
-- PHI posture: step bodies and rendered call scripts are patient-facing
-- copy and live only in the DB (like messages.body). Log lines and
-- audit metadata carry ids + structural reason codes, never bodies.

CREATE TABLE IF NOT EXISTS "resupply"."outreach_playbooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "playbook_key" varchar(120) NOT NULL,
  "name" varchar(200) NOT NULL,
  "situation" text NOT NULL,
  "description" text,
  "category" varchar(40) NOT NULL DEFAULT 'engagement',
  "is_active" boolean NOT NULL DEFAULT true,
  -- Seeded rows survive edits but are flagged so the UI can label the
  -- starting library vs. operator-built playbooks.
  "is_seeded" boolean NOT NULL DEFAULT false,
  "created_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "outreach_playbooks_key_unique" UNIQUE ("playbook_key")
);

CREATE TABLE IF NOT EXISTS "resupply"."outreach_playbook_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "playbook_id" uuid NOT NULL REFERENCES "resupply"."outreach_playbooks"("id") ON DELETE CASCADE,
  -- 1-based position in the cadence.
  "step_index" integer NOT NULL,
  -- Days after the run starts (0 = first dispatcher tick after start).
  "day_offset" integer NOT NULL,
  "channel" varchar(10) NOT NULL,
  -- Email subject; NULL for sms / call steps.
  "subject" varchar(200),
  -- SMS body, email body, or staff call script. {{first_name}} and
  -- {{practice_name}} are substituted at send time.
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "outreach_playbook_steps_channel_check"
    CHECK ("channel" IN ('sms', 'email', 'call')),
  CONSTRAINT "outreach_playbook_steps_day_offset_check"
    CHECK ("day_offset" >= 0 AND "day_offset" <= 365),
  CONSTRAINT "outreach_playbook_steps_unique" UNIQUE ("playbook_id", "step_index")
);

CREATE TABLE IF NOT EXISTS "resupply"."outreach_playbook_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "playbook_id" uuid NOT NULL REFERENCES "resupply"."outreach_playbooks"("id") ON DELETE CASCADE,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  -- Pointer to the NEXT step to execute (1-based). The dispatcher
  -- claims a step by advancing this pointer with an optimistic WHERE
  -- pinning the prior value — same idempotency pattern as the fitter
  -- supply campaign's campaign_touch_count.
  "next_step_index" integer NOT NULL DEFAULT 1,
  "next_step_at" timestamptz,
  "started_by_user_id" uuid,
  "started_by_email" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "outreach_playbook_runs_status_check"
    CHECK ("status" IN ('active', 'completed', 'cancelled'))
);

-- One live run per (playbook, patient); finished runs keep history.
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_playbook_runs_active_uniq"
  ON "resupply"."outreach_playbook_runs" ("playbook_id", "patient_id")
  WHERE "status" = 'active';

-- Dispatcher drain: active runs due now.
CREATE INDEX IF NOT EXISTS "outreach_playbook_runs_due_idx"
  ON "resupply"."outreach_playbook_runs" ("next_step_at")
  WHERE "status" = 'active';

CREATE INDEX IF NOT EXISTS "outreach_playbook_runs_patient_idx"
  ON "resupply"."outreach_playbook_runs" ("patient_id");

CREATE TABLE IF NOT EXISTS "resupply"."outreach_playbook_step_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "resupply"."outreach_playbook_runs"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL,
  "channel" varchar(10) NOT NULL,
  -- sent | failed | skipped (sms/email) ; call_due | call_completed (call)
  "status" varchar(30) NOT NULL,
  -- Structural reason code for failed/skipped — never message bodies.
  "detail" varchar(200),
  -- Rendered staff call script, snapshotted at due time so later edits
  -- to the playbook don't rewrite history. call steps only.
  "call_script" text,
  -- Disposition logged by the CSR when completing a call task
  -- (mirrors click-to-dial CALL_OUTCOMES).
  "call_outcome" varchar(30),
  "completed_by_email" text,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "outreach_playbook_step_log_unique" UNIQUE ("run_id", "step_index")
);

-- Staff call queue: due call tasks, oldest first.
CREATE INDEX IF NOT EXISTS "outreach_playbook_step_log_call_due_idx"
  ON "resupply"."outreach_playbook_step_log" ("created_at")
  WHERE "status" = 'call_due';

-- Control Center toggle for the dispatcher. Seeded ON: playbooks only
-- send for runs a staff member explicitly started, so the flag gates
-- "scheduled touches keep flowing", not unsolicited outreach.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('outreach_playbooks.dispatcher',
   true,
   'Outreach playbooks — scheduled SMS/email touches and call tasks for patient outreach runs started by staff. Turning this OFF pauses all pending playbook touches without cancelling the runs.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------
-- Starting library. ON CONFLICT DO NOTHING keeps re-runs idempotent
-- and never clobbers operator edits (edits keep the playbook_key).
-- SMS bodies stay GSM-7-safe (no em dashes / curly quotes) and end
-- with the STOP opt-out per messaging convention.
-- ---------------------------------------------------------------

INSERT INTO resupply.outreach_playbooks
  (playbook_key, name, situation, description, category, is_seeded)
VALUES
  ('resupply_due',
   'Supplies due for re-order',
   'The patient is eligible to replace supplies (cushion, filters, tubing) but has not placed the order.',
   'Three touches over ten days: a detailed email, a short SMS nudge, then a personal call for patients who have not responded.',
   'resupply', true),
  ('compliance_at_risk',
   'Not meeting compliance goals',
   'Therapy data shows low usage and the patient is at risk of missing their compliance window (insurance coverage may depend on it).',
   'Coaching-first cadence: open with a supportive call, follow with encouragement by SMS and email, close with a check-in call.',
   'clinical', true),
  ('fitter_no_order',
   'Used the mask fitter, no order yet',
   'The patient completed the at-home mask fitting and received a recommendation but has not ordered.',
   'Warm recap by SMS while the fitting is fresh, a detail email two days later, and a personal call after a week.',
   'sales', true),
  ('new_patient_welcome',
   'New patient first-week welcome',
   'A patient just started therapy with us and the first week decides long-term adherence.',
   'Welcome SMS on day one, a setup check-in call on day three, and a tips email at the end of the first week.',
   'onboarding', true),
  ('post_delivery_checkin',
   'Order delivered, comfort check',
   'An order was recently delivered and we want to confirm fit and comfort before small problems become returns.',
   'A quick SMS two days after delivery and a follow-up email at one week.',
   'service', true),
  ('lapsed_reengage',
   'No response in a while',
   'The patient has stopped responding to reminders or has gone quiet for several months.',
   'A re-introduction email, a short SMS, then a personal call to find out what changed.',
   'engagement', true)
ON CONFLICT (playbook_key) DO NOTHING;

WITH p AS (
  SELECT id FROM resupply.outreach_playbooks WHERE playbook_key = 'resupply_due'
)
INSERT INTO resupply.outreach_playbook_steps
  (playbook_id, step_index, day_offset, channel, subject, body)
SELECT p.id, v.step_index, v.day_offset, v.channel, v.subject, v.body
FROM p, (VALUES
  (1, 0, 'email', 'Your CPAP supplies are due for replacement',
   E'Hi {{first_name}},\n\nIt''s {{practice_name}}. Our records show your CPAP supplies are due for replacement. Worn cushions and clogged filters are the most common reason therapy starts feeling worse, and most insurance plans cover replacements on this schedule.\n\nReply to this email or give us a call and we''ll get a refill on its way to the address on file.\n\nSleep well,\n{{practice_name}}'),
  (2, 3, 'sms', NULL,
   'Hi {{first_name}}, it''s {{practice_name}}. Your CPAP supplies are due for replacement. Reply YES and we''ll get your refill started, or call us with any questions. Reply STOP to opt out.'),
  (3, 10, 'call', NULL,
   E'Goal: help the patient re-order supplies they are eligible for.\n\n1. Confirm you''re speaking with {{first_name}}; introduce yourself from {{practice_name}}.\n2. Mention we emailed and texted about supplies being due; ask if they saw it.\n3. Ask how the current mask and supplies are feeling (seal, comfort, noise).\n4. Offer to place the refill now to the address on file; confirm items.\n5. If declined, ask when they''d like us to check back and note it on the patient.')
) AS v(step_index, day_offset, channel, subject, body)
ON CONFLICT (playbook_id, step_index) DO NOTHING;

WITH p AS (
  SELECT id FROM resupply.outreach_playbooks WHERE playbook_key = 'compliance_at_risk'
)
INSERT INTO resupply.outreach_playbook_steps
  (playbook_id, step_index, day_offset, channel, subject, body)
SELECT p.id, v.step_index, v.day_offset, v.channel, v.subject, v.body
FROM p, (VALUES
  (1, 0, 'call', NULL,
   E'Goal: supportive coaching call, not a compliance lecture.\n\n1. Confirm you''re speaking with {{first_name}}; introduce yourself from {{practice_name}}.\n2. Lead with care: "We noticed therapy time has dipped and wanted to check how you''re doing."\n3. Ask open questions: mask comfort? dryness? trouble falling asleep with it? pressure feel?\n4. Offer one concrete fix for whatever they name (mask refit, humidifier setting, ramp).\n5. Remind them gently that insurance looks at usage in this window; we''re here to help them hit it.\n6. Agree on one small goal for this week and note it on the patient.'),
  (2, 2, 'sms', NULL,
   'Hi {{first_name}}, it''s {{practice_name}}. Just checking in on your CPAP this week. Even one extra hour a night makes a real difference. Reply here if anything feels off and we''ll help. Reply STOP to opt out.'),
  (3, 7, 'email', 'A few small changes that make CPAP easier',
   E'Hi {{first_name}},\n\nIt''s {{practice_name}}. Sticking with CPAP is hardest in the early weeks, and small adjustments usually fix the things that make people give up:\n\n- Mask leaks or soreness: you may need a different size or style. Re-fits are quick and free.\n- Dry nose or mouth: a humidifier setting change usually solves it overnight.\n- Hard to fall asleep: the ramp feature starts the pressure low and builds gradually.\n\nReply to this email or call us and we''ll work through it together. Your insurance also looks at usage during this period, so a quick fix now protects your coverage too.\n\nWe''re rooting for you,\n{{practice_name}}'),
  (4, 14, 'call', NULL,
   E'Goal: two-week follow-up on the compliance coaching call.\n\n1. Confirm you''re speaking with {{first_name}}; remind them of the earlier conversation.\n2. Ask how the week went and whether the fix we agreed on helped.\n3. Review usage together if they''re open to it; celebrate any improvement.\n4. If still struggling, offer a mask refit appointment or a clinician follow-up.\n5. Note the outcome and any next steps on the patient.')
) AS v(step_index, day_offset, channel, subject, body)
ON CONFLICT (playbook_id, step_index) DO NOTHING;

WITH p AS (
  SELECT id FROM resupply.outreach_playbooks WHERE playbook_key = 'fitter_no_order'
)
INSERT INTO resupply.outreach_playbook_steps
  (playbook_id, step_index, day_offset, channel, subject, body)
SELECT p.id, v.step_index, v.day_offset, v.channel, v.subject, v.body
FROM p, (VALUES
  (1, 0, 'sms', NULL,
   'Hi {{first_name}}, it''s {{practice_name}}. Your mask fitting results are saved and your recommendation is on hold for you. Reply here or call us if you have questions. Reply STOP to opt out.'),
  (2, 2, 'email', 'Your mask recommendation is waiting',
   E'Hi {{first_name}},\n\nIt''s {{practice_name}}. You recently ran our at-home mask fitting and we matched you to a mask based on your measurements. Those measurements are saved, so there''s nothing to redo.\n\nMost patients tell us the right mask is what finally made therapy comfortable. If you''re unsure about anything (fit, insurance coverage, pricing), just reply to this email; a real person reads every reply.\n\nSleep well,\n{{practice_name}}'),
  (3, 7, 'call', NULL,
   E'Goal: turn a completed fitting into a comfortable first order.\n\n1. Confirm you''re speaking with {{first_name}}; introduce yourself from {{practice_name}}.\n2. Mention they completed our mask fitting and we wanted to follow up personally.\n3. Ask what held them back: price? insurance questions? unsure about the recommendation?\n4. Answer directly; offer to check their insurance coverage while on the phone.\n5. Offer to place the order together now, or note when to check back.')
) AS v(step_index, day_offset, channel, subject, body)
ON CONFLICT (playbook_id, step_index) DO NOTHING;

WITH p AS (
  SELECT id FROM resupply.outreach_playbooks WHERE playbook_key = 'new_patient_welcome'
)
INSERT INTO resupply.outreach_playbook_steps
  (playbook_id, step_index, day_offset, channel, subject, body)
SELECT p.id, v.step_index, v.day_offset, v.channel, v.subject, v.body
FROM p, (VALUES
  (1, 1, 'sms', NULL,
   'Hi {{first_name}}, welcome to {{practice_name}}! The first nights on CPAP can feel strange and that''s normal. Reply here any time with questions, we''re real people and happy to help. Reply STOP to opt out.'),
  (2, 3, 'call', NULL,
   E'Goal: day-three setup check for a brand-new patient.\n\n1. Confirm you''re speaking with {{first_name}}; welcome them to {{practice_name}}.\n2. Ask how the first nights went: falling asleep OK? mask staying sealed? any dryness?\n3. Walk through one fix for anything they name (humidifier, ramp, strap tension).\n4. Remind them the first two weeks are the adjustment period and it gets easier.\n5. Tell them how to reach us (text this number, call, or email) and note any follow-ups.'),
  (3, 7, 'email', 'One week in: what most CPAP patients notice next',
   E'Hi {{first_name}},\n\nIt''s {{practice_name}}. You''re one week in, and this is usually when therapy starts paying off: fewer morning headaches, steadier daytime energy, and a quieter night for anyone sharing the room.\n\nA few tips for week two:\n\n- Clean the cushion with warm soapy water every few days; oils from skin loosen the seal.\n- If you wake with a dry mouth, nudge the humidifier up one level.\n- Keep a consistent bedtime; the routine makes the mask feel automatic faster.\n\nReply to this email if anything feels off. We''d rather fix a small annoyance now than have it cost you sleep.\n\nWelcome aboard,\n{{practice_name}}')
) AS v(step_index, day_offset, channel, subject, body)
ON CONFLICT (playbook_id, step_index) DO NOTHING;

WITH p AS (
  SELECT id FROM resupply.outreach_playbooks WHERE playbook_key = 'post_delivery_checkin'
)
INSERT INTO resupply.outreach_playbook_steps
  (playbook_id, step_index, day_offset, channel, subject, body)
SELECT p.id, v.step_index, v.day_offset, v.channel, v.subject, v.body
FROM p, (VALUES
  (1, 2, 'sms', NULL,
   'Hi {{first_name}}, it''s {{practice_name}}. Your order should have arrived. How is everything fitting? Reply here if anything feels off and we''ll make it right. Reply STOP to opt out.'),
  (2, 7, 'email', 'How is the new equipment treating you?',
   E'Hi {{first_name}},\n\nIt''s {{practice_name}}, checking in on your recent order. A week is about when fit issues show up, and small ones are easy to fix:\n\n- Red marks or soreness usually mean the straps are too tight, not too loose.\n- A faint whistle or leak often just needs the cushion re-seated.\n- If something simply isn''t comfortable, ask us about a swap; we''d rather exchange it than have you tough it out.\n\nReply to this email and a real person will help.\n\nSleep well,\n{{practice_name}}')
) AS v(step_index, day_offset, channel, subject, body)
ON CONFLICT (playbook_id, step_index) DO NOTHING;

WITH p AS (
  SELECT id FROM resupply.outreach_playbooks WHERE playbook_key = 'lapsed_reengage'
)
INSERT INTO resupply.outreach_playbook_steps
  (playbook_id, step_index, day_offset, channel, subject, body)
SELECT p.id, v.step_index, v.day_offset, v.channel, v.subject, v.body
FROM p, (VALUES
  (1, 0, 'email', 'We''re still here when you''re ready',
   E'Hi {{first_name}},\n\nIt''s {{practice_name}}. It''s been a while since we''ve heard from you, and we wanted to check in rather than assume.\n\nIf therapy fell off, you''re in good company; most people who pause come back once the original problem (comfort, dryness, the mask itself) gets fixed, and fixes are usually quick. If you''re sleeping fine and just haven''t needed us, even better.\n\nEither way, your file and history are right where you left them. Reply to this email or call and we''ll pick up from there.\n\n{{practice_name}}'),
  (2, 4, 'sms', NULL,
   'Hi {{first_name}}, it''s {{practice_name}}. It''s been a while! If CPAP got uncomfortable or supplies ran low, reply here and we''ll help you get back on track. Reply STOP to opt out.'),
  (3, 10, 'call', NULL,
   E'Goal: find out why the patient went quiet and remove that blocker.\n\n1. Confirm you''re speaking with {{first_name}}; introduce yourself from {{practice_name}}.\n2. Be human: "We noticed we haven''t talked in a while and wanted to check in."\n3. Listen for the real reason: comfort, cost, insurance change, moved, switched provider.\n4. Offer the matching next step (refit, supplies refresh, insurance re-check, update records).\n5. If they''ve moved on, thank them, ask if they''d like us to stop outreach, and note it.')
) AS v(step_index, day_offset, channel, subject, body)
ON CONFLICT (playbook_id, step_index) DO NOTHING;
