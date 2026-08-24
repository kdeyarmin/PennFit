-- 0516_fitter_fit_requests — the patient stops self-submitting orders and
-- raises their hand instead.
--
-- What changes
-- ------------
-- The virtual mask fitter used to end at `/order`: the patient typed
-- their own shipping address, insurance member ID and prescriber into a
-- form that inserted straight into `public.orders`. Nobody at the DME
-- reviewed it before it existed. That is the wrong end of the funnel to
-- automate — the mask recommendation is the valuable part; the order is
-- the part that needs a human who can check benefits, confirm the size
-- in person, and chase the prescription.
--
-- So the fitter now ends in a REQUEST. The patient either fills in what
-- they know (this table's `full_details` mode) or simply asks to be
-- called back (`callback`), and staff work the queue. Nothing here is an
-- order; nothing here bills; nothing here ships.
--
-- Why its own table rather than `fitter_leads`
-- --------------------------------------------
-- `fitter_leads` is the MARKETING funnel — email opt-in, nurture touches,
-- an unsubscribe pipeline. It holds an email, a phone and a mask name,
-- and its rows are fed to a campaign dispatcher. A date of birth and an
-- insurance member ID do not belong in a table whose rows exist to be
-- mailed. This table is the fulfilment-side artifact: it holds what a CSR
-- needs to place the order themselves, and no worker sends from it.
--
-- The two are linked (`fitter_lead_id`) so the queue can be worked
-- alongside the funnel, and the lead row is stamped
-- `contact_requested_at` so the existing Fitter Prospects page can show
-- which prospects have raised their hand without reading this table.
--
-- PHI
-- ---
-- Rows here carry patient-identifying detail (name, DOB, insurance IDs).
-- Same handling as `insurance_leads`: admin-gated reads, counts-only log
-- lines, no measurements (those live on the fit session / invite, which
-- already store them and already never store images).
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."fitter_fit_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),

  -- 'full_details' — the patient filled in the form.
  -- 'callback'     — the patient asked to be contacted; name + one
  --                  contact channel is all we have, and that is fine.
  "request_type" text NOT NULL DEFAULT 'full_details',

  -- Staff workflow. Mirrors insurance_leads' lifecycle so a CSR moving
  -- between the two queues does not have to learn a second vocabulary.
  "status" text NOT NULL DEFAULT 'new',

  -- ── Contact ──
  "full_name" text NOT NULL,
  -- Required: the fitter cannot be entered without an email (/consent
  -- gates on it), and it is where the confirmation goes.
  "email" text NOT NULL,
  -- NULLABLE on purpose. A patient who asked to be reached by email
  -- should not have to invent a phone number to be allowed to ask for
  -- help; the route requires one only when they chose phone or text.
  "phone" text,
  "preferred_contact_method" text NOT NULL DEFAULT 'phone',
  -- Free text ("mornings", "after 5"), shown to the CSR verbatim.
  "preferred_contact_time" text,
  -- Nullable: a callback request does not ask for it.
  "date_of_birth" text,

  -- ── Insurance, all optional ──
  -- The patient is not required to know any of this. A blank carrier is
  -- a normal outcome, not a validation failure: the whole point of the
  -- change is that staff verify benefits, so a request with nothing but
  -- a name and a phone number is still a good request.
  "insurance_carrier" text,
  "member_id" text,
  "group_number" text,
  "prescribing_physician" text,
  "notes" text,

  -- ── Fitting context ──
  -- Product references and the service line, NOT clinical findings. Kept
  -- so the CSR opening this row can see what the patient was shown
  -- without cross-referencing the fitting record.
  "population" text NOT NULL DEFAULT 'adult',
  "fitter_lead_id" text
    REFERENCES "resupply"."fitter_leads"("id") ON DELETE SET NULL,
  "fit_session_id" uuid
    REFERENCES "resupply"."fit_sessions"("id") ON DELETE SET NULL,
  "recommended_mask_id" text,
  "recommended_mask_name" text,
  "recommended_mask_type" text,
  "recommended_mask_size" text,

  -- ── CSR workflow ──
  "csr_note" text,
  "contacted_at" timestamp with time zone,
  "contacted_by" text,
  "closed_at" timestamp with time zone,

  -- Rate-limit forensics only; both can be nulled without losing the
  -- request.
  "submitter_ip" text,
  "user_agent" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "fitter_fit_requests_request_type_chk"
    CHECK ("request_type" IN ('full_details', 'callback')),
  CONSTRAINT "fitter_fit_requests_status_chk"
    CHECK ("status" IN ('new', 'contacted', 'in_progress', 'closed')),
  CONSTRAINT "fitter_fit_requests_population_chk"
    CHECK ("population" IN ('adult', 'pediatric')),
  CONSTRAINT "fitter_fit_requests_contact_method_chk"
    CHECK ("preferred_contact_method" IN ('phone', 'email', 'text'))
);
--> statement-breakpoint

-- The queue's dominant read: "show me this tenant's open requests,
-- newest first". Status leads because the page defaults to `new`.
CREATE INDEX IF NOT EXISTS "fitter_fit_requests_org_status_created_idx"
  ON "resupply"."fitter_fit_requests" ("org_id", "status", "created_at" DESC);
--> statement-breakpoint

-- A CSR pasting a patient's email into the global lookup bar. The API
-- lowercases before insert, so a plain B-tree is enough.
CREATE INDEX IF NOT EXISTS "fitter_fit_requests_org_email_idx"
  ON "resupply"."fitter_fit_requests" ("org_id", "email");
--> statement-breakpoint

-- Reverse lookup from the marketing funnel row.
CREATE INDEX IF NOT EXISTS "fitter_fit_requests_lead_idx"
  ON "resupply"."fitter_fit_requests" ("fitter_lead_id")
  WHERE "fitter_lead_id" IS NOT NULL;
--> statement-breakpoint

-- Keep `updated_at` honest without every writer remembering to set it.
-- `resupply.set_updated_at()` was created in migration 0054 and is what
-- every other table's updated_at trigger calls (0056/0060).
DROP TRIGGER IF EXISTS trg_fitter_fit_requests_set_updated_at
  ON resupply.fitter_fit_requests;
--> statement-breakpoint
CREATE TRIGGER trg_fitter_fit_requests_set_updated_at
  BEFORE UPDATE ON resupply.fitter_fit_requests
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Surface the raised hand on the existing Fitter Prospects queue.
-- ---------------------------------------------------------------
-- Additive + nullable. The nurture dispatchers ignore it; it exists so
-- the page staff already open can sort a prospect who asked to be
-- contacted above one who merely finished a fitting.
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "contact_requested_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fitter_leads_contact_requested_idx"
  ON "resupply"."fitter_leads" ("contact_requested_at" DESC)
  WHERE "contact_requested_at" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- fitter.lead_capture_only — seeded ON for every tenant.
-- ---------------------------------------------------------------
-- This is the flag that actually removes the self-serve order form, and
-- it is the ONE fitter flag that ships ON rather than as an opt-in.
--
-- Seeding it OFF would mean every existing tenant keeps letting patients
-- file their own insurance orders until somebody notices a toggle, which
-- is the behaviour this change exists to end. A tenant that genuinely
-- wants patient self-service can turn it off deliberately; the default
-- should be the one that puts a human between a patient's guess at their
-- member ID and a claim.
--
-- The SPA also fails SOFT to on: an unresolvable flag lookup must not
-- hand a patient the order form. See `leadCaptureOnly` in
-- artifacts/cpap-fitter/src/hooks/use-fitter-store.tsx.
--
-- Keep in lockstep with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts — a key here that is
-- missing there silently no-ops in the admin toggle UI.

INSERT INTO resupply.feature_flags
  ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM resupply.organizations o
CROSS JOIN (VALUES
  ('fitter.lead_capture_only',
   true,
   'End the mask fitter with a REQUEST instead of an order. ON: the '
     || 'patient sees their recommendation and either sends their '
     || 'details or asks to be called back, and the request lands in '
     || 'Fitter > Fit Requests for a person to work — nothing is '
     || 'ordered, billed or shipped without staff. OFF: the patient can '
     || 'submit their own insurance order (shipping, member ID, '
     || 'prescriber) straight into the order queue, as before.',
   'Clinical')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
