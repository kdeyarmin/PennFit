-- Smart Notes — AI-reviewed, Medicare-compliance-checked clinical notes.
--
-- A nurse/clinician writes a free-text note on a patient. Before it is
-- saved, the note is reviewed by an LLM against (a) a fixed checklist of
-- Medicare documentation elements required for PAP/CPAP continued
-- coverage (LCD L33718 territory), and (b) the patient's own chart data
-- (most-recent sleep study + recent therapy-night adherence) so the note
-- can be cross-checked for consistency. The structured review is frozen
-- onto the row at save time, and each new note is also compared against
-- the patient's PREVIOUS smart note so trends/changes are surfaced.
--
-- Append-only by design, mirroring `patient_notes`: a note is a record of
-- "what the clinician documented at this moment", and the review/trend
-- snapshots are the AI's assessment at that moment. There is no
-- PATCH/DELETE — rewriting history defeats the compliance-trail purpose.
--
-- PHI posture: `note_text` is clinical free-text and carries PHI; the
-- `review` / `comparison` JSON can quote the note. Stored as plaintext
-- (consistent with `patient_notes` post-0025) and NEVER logged. The
-- application logger only ever records structural metadata (lengths,
-- score, compliant boolean) — never the note body or review prose.

CREATE TABLE IF NOT EXISTS "resupply"."smart_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients" ("id") ON DELETE CASCADE,
  "note_text" text NOT NULL,
  "author_email" text NOT NULL,
  "author_user_id" uuid,
  -- Overall compliance verdict (all required elements present) + a
  -- 0..100 score (percent of required elements documented). Denormalized
  -- out of `review` so the timeline list can sort/badge without parsing
  -- JSON.
  "compliant" boolean NOT NULL DEFAULT false,
  "compliance_score" integer NOT NULL DEFAULT 0,
  -- Full structured AI review: per-element checklist, missing elements,
  -- suggestions, and chart-consistency findings. Shape owned by
  -- artifacts/resupply-api/src/lib/clinical/smart-note-compliance.ts.
  "review" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Trend comparison vs the patient's previous smart note (changes the
  -- model noticed). Empty object for the patient's first note.
  "comparison" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which provider/model produced the review ("anthropic" / "openai" /
  -- "offline") + the prompt version, for auditability of AI output.
  "review_provider" text NOT NULL DEFAULT 'offline',
  "prompt_version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-->

-- Timeline read pattern: newest-first per patient.
CREATE INDEX IF NOT EXISTS "smart_notes_patient_created_idx"
  ON "resupply"."smart_notes" ("patient_id", "created_at" DESC);
