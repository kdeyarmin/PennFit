-- 0484_safety_screening — version-controlled magnetic-component screening.
--
-- Why
-- ---
-- Several current-generation masks use magnetic headgear clips, and
-- manufacturers have issued safety notices about them near implanted
-- devices (pacemakers, ICDs, aneurysm clips, cochlear implants, shunts,
-- metallic ocular implants). The risk is not limited to the patient — a
-- household member who handles or sleeps beside the mask matters too.
--
-- The screen has to be documented, and it has to be VERSIONED: when a
-- manufacturer revises a warning, we need to know which wording a given
-- patient actually saw and agreed to, months or years later.
--
-- Model
-- -----
--   safety_screen_versions   — a published question set at a version
--   safety_screen_questions  — the individual prompts
--
-- THE KEY DESIGN CALL: the exclusion RULE is data, not code.
-- `disqualifies_attribute` names the mask_models column a positive
-- answer excludes on ('has_magnetic_components'), `severity` says
-- whether that is a hard exclusion or a warning, and `unsure_behaves_as`
-- says what a hedged answer does. The engine reads all three from the
-- pinned set version. So revising a warning — or adding a
-- manufacturer-specific question — is a new version row, not a deploy,
-- and the fit report can cite `magnetic_implant@v1` precisely.
--
-- `org_id` is nullable, same pattern as the catalog in 0481: NULL = the
-- platform-published set every tenant gets. A tenant may publish its own
-- stricter set without affecting anyone else.
--
-- Responses live in fit_session_safety_responses (0483), tenant-scoped
-- and PHI-bearing. This table holds only the questions.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."safety_screen_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL = platform-published set. Non-NULL = a tenant's own set.
  "org_id" uuid REFERENCES "resupply"."organizations"("id"),
  -- Stable family key, e.g. 'magnetic_implant'.
  "slug" text NOT NULL,
  -- Human-facing version label stamped onto every response and printed
  -- on the fit report, e.g. '2026-08.v1'.
  "version" text NOT NULL,
  "scope" text NOT NULL DEFAULT 'magnetic',
  -- Set when the questions come from one manufacturer's notice rather
  -- than a general clinical policy.
  "manufacturer" text,
  "status" text NOT NULL DEFAULT 'draft',
  "title" text NOT NULL,
  "intro_copy" text,
  -- The exact "I confirm ..." sentence, snapshotted per session into
  -- fit_sessions.safety_snapshot so the report reproduces what was shown.
  "attestation_copy" text NOT NULL,
  "source_url" text,
  "source_version_date" date,
  "effective_from" date,
  "retired_on" date,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "safety_screen_versions_scope_chk"
    CHECK ("scope" IN ('magnetic', 'general')),
  CONSTRAINT "safety_screen_versions_status_chk"
    CHECK ("status" IN ('draft', 'active', 'retired'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "safety_screen_versions_platform_idx"
  ON "resupply"."safety_screen_versions" ("slug", "version")
  WHERE "org_id" IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "safety_screen_versions_org_idx"
  ON "resupply"."safety_screen_versions" ("org_id", "slug", "version")
  WHERE "org_id" IS NOT NULL;
--> statement-breakpoint

-- At most one active platform set per family.
CREATE UNIQUE INDEX IF NOT EXISTS "safety_screen_versions_one_active_idx"
  ON "resupply"."safety_screen_versions" ("slug")
  WHERE "org_id" IS NULL AND "status" = 'active';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "safety_screen_versions_lookup_idx"
  ON "resupply"."safety_screen_versions" ("org_id", "slug", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."safety_screen_questions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "screen_version_id" uuid NOT NULL
    REFERENCES "resupply"."safety_screen_versions"("id") ON DELETE CASCADE,
  "question_key" text NOT NULL,
  "prompt" text NOT NULL,
  "help_text" text,
  "subject" text NOT NULL DEFAULT 'patient',
  "answer_type" text NOT NULL DEFAULT 'yes_no_unsure',
  "sort_order" integer NOT NULL DEFAULT 0,
  -- The safety_flags entry a positive answer raises on the session.
  "risk_flag" text NOT NULL,
  -- The mask_models boolean column a positive answer disqualifies on.
  -- NULL = the question is recorded but excludes nothing by itself.
  "disqualifies_attribute" text,
  "severity" text NOT NULL DEFAULT 'exclude',
  "unsure_behaves_as" text NOT NULL DEFAULT 'exclude',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "safety_screen_questions_subject_chk"
    CHECK ("subject" IN ('patient', 'household')),
  CONSTRAINT "safety_screen_questions_answer_type_chk"
    CHECK ("answer_type" IN ('yes_no_unsure')),
  CONSTRAINT "safety_screen_questions_severity_chk"
    CHECK ("severity" IN ('exclude', 'warn')),
  CONSTRAINT "safety_screen_questions_unsure_chk"
    CHECK ("unsure_behaves_as" IN ('exclude', 'warn', 'ignore')),
  CONSTRAINT "safety_screen_questions_disqualifies_chk"
    CHECK ("disqualifies_attribute" IS NULL
           OR "disqualifies_attribute" IN ('has_magnetic_components'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "safety_screen_questions_key_idx"
  ON "resupply"."safety_screen_questions"
     ("screen_version_id", "question_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "safety_screen_questions_order_idx"
  ON "resupply"."safety_screen_questions"
     ("screen_version_id", "sort_order");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Seed: the platform magnetic-implant screen, v1.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."safety_screen_versions"
  ("org_id", "slug", "version", "scope", "status", "title",
   "intro_copy", "attestation_copy", "effective_from")
VALUES (
  NULL,
  'magnetic_implant',
  '2026-08.v1',
  'magnetic',
  'active',
  'Magnetic component safety check',
  'Some CPAP masks use magnets in the headgear clips. Magnets can '
  || 'interfere with certain implanted medical devices. These questions '
  || 'are about you and about anyone who shares your home — a magnet '
  || 'can affect someone who handles the mask or sleeps beside you, not '
  || 'just the person wearing it. If you are not sure about an answer, '
  || 'choose "Not sure" and we will treat it cautiously.',
  'I confirm that the answers above are accurate to the best of my '
  || 'knowledge, and I understand that masks with magnetic components '
  || 'will be excluded from my recommendations if any answer indicates a '
  || 'possible risk.',
  DATE '2026-08-01'
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "resupply"."safety_screen_questions"
  ("screen_version_id", "question_key", "prompt", "help_text", "subject",
   "sort_order", "risk_flag", "disqualifies_attribute", "severity",
   "unsure_behaves_as")
SELECT
  v."id", q."question_key", q."prompt", q."help_text", q."subject",
  q."sort_order", q."risk_flag", 'has_magnetic_components',
  'exclude', 'exclude'
FROM "resupply"."safety_screen_versions" v
CROSS JOIN (VALUES
  ('patient_cardiac_device',
   'Do you have a pacemaker, defibrillator (ICD), or other implanted '
     || 'heart device?',
   'This includes leadless pacemakers and implanted loop recorders.',
   'patient', 10, 'magnet_implant_patient'),
  ('patient_neuro_implant',
   'Do you have an aneurysm clip, neurostimulator, or a shunt with an '
     || 'adjustable valve?',
   'Programmable shunt valves and deep-brain or vagus-nerve '
     || 'stimulators all count.',
   'patient', 20, 'magnet_implant_patient'),
  ('patient_cochlear_ocular',
   'Do you have a cochlear implant, a metallic eye implant, or metal '
     || 'fragments in or near your eyes?',
   NULL,
   'patient', 30, 'magnet_implant_patient'),
  ('patient_other_metallic',
   'Do you have any other implanted metallic or magnetic medical '
     || 'device?',
   'Insulin pumps, magnetic sphincter devices, and certain dental or '
     || 'skull implants all count.',
   'patient', 40, 'magnet_implant_patient'),
  ('household_cardiac_device',
   'Does anyone who lives with you have a pacemaker, defibrillator '
     || '(ICD), or other implanted heart device?',
   'Answer yes if a household member might handle the mask or sleep '
     || 'next to you while you wear it.',
   'household', 50, 'magnet_implant_household'),
  ('household_other_implant',
   'Does anyone who lives with you have another implanted metallic or '
     || 'magnetic medical device?',
   'This includes aneurysm clips, neurostimulators, adjustable shunt '
     || 'valves, and cochlear implants.',
   'household', 60, 'magnet_implant_household')
) AS q("question_key", "prompt", "help_text", "subject",
       "sort_order", "risk_flag")
WHERE v."org_id" IS NULL
  AND v."slug" = 'magnetic_implant'
  AND v."version" = '2026-08.v1'
ON CONFLICT ("screen_version_id", "question_key") DO NOTHING;
