# PennPaps — CPAP Mask Fitter

## Overview

PennPaps is a web application that helps patients select the most suitable CPAP mask. The application prioritizes user privacy through on-device facial measurements and combines this with a clinical questionnaire to provide personalized, justified mask recommendations from the PennPaps product catalog. It also facilitates order placement and adheres to PennPaps brand guidelines, including an animated tutorial for user guidance.

**Brand & Contact**

The site is branded as **PennPaps**. The universal contact email used throughout all user-facing surfaces is `info@pennpaps.com` (overridable in the dashboard via `VITE_RESUPPLY_CONTACT_EMAIL`). Default practice name baked into outbound SMS, email, and voice templates is **PennPaps** (overridable via `RESUPPLY_PRACTICE_NAME`). The Clerk-hosted sign-in screen title (currently "Mask Fit Assistant") is configured in the Clerk Dashboard, not in code, and must be updated there to complete the rebrand on that surface.

Internal package directory names (`@workspace/resupply-*`, `@workspace/penn-fit-tutorial`, `RESUPPLY_*` env vars, `resupply.*` Postgres schema) are intentionally retained — those are stable identifiers, not user-facing brand surfaces.

**Key Capabilities:**

*   **Privacy-First Facial Measurement:** On-device processing of facial images for measurements, without transmitting or storing sensitive image data.
*   **Clinical Questionnaire:** Gathers patient data for refined mask recommendations.
*   **Personalized Mask Recommendations:** Delivers a ranked list of masks with justifications based on facial fit and clinical needs.
*   **Order Placement:** Securely submits orders to PennPaps via a stateless API.
*   **Brand Alignment:** Incorporates the PennPaps visual design system.
*   **Tutorial:** Guides users through the fitting process with an animated video.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log order request bodies in the application logger (treat every log line as world-readable).

## System Architecture

The PennPaps application employs a privacy-first, stateless architecture, emphasizing on-device processing for sensitive data and secure handling of persistent information.

### Privacy and Data Handling

Facial image processing is entirely on-device using MediaPipe Face Mesh; only numeric measurements are sent to the backend. The recommendation engine is stateless. Order data, including PHI, is persisted in PostgreSQL to facilitate shipping, billing, and prescription verification via an internal admin dashboard. Camera images and video streams are never uploaded or stored.

### Admin Dashboard

An internal admin dashboard (`/admin/*`) allows Penn staff to manage orders. Access is restricted via Clerk authentication and an email allowlist (`PENN_ADMIN_EMAILS`). All PHI-touching admin reads are logged in an `admin_audit_log` table.

### Technical Stack

*   **Monorepo Tool:** pnpm workspaces
*   **Node.js:** v24
*   **Package Manager:** pnpm
*   **TypeScript:** v5.9
*   **API Framework:** Express 5
*   **Validation:** Zod (from OpenAPI spec)
*   **API Codegen:** Orval
*   **On-device AI:** MediaPipe Face Mesh (`@mediapipe/tasks-vision`)
*   **Frontend:** React, Vite, Tailwind CSS, Wouter
*   **Database:** Drizzle ORM + node-postgres (`@workspace/db`) for `orders`, `usage_events`, `admin_audit_log`.
*   **Authentication:** Clerk (`@clerk/express`, `@clerk/react`, `@clerk/themes`) for admin authentication.

### Application Flow

The user journey is structured into several stages: Home, Consent, Capture (facial scan), Measure (on-device processing), Questionnaire, Results (mask recommendations), Order (intake form), Order Success, Masks (catalog browser), and Privacy policy.

### Recommendation Scoring

The recommendation engine calculates a combined score using: `Combined score = (typeScore × 0.60 + fitScore × 0.40) × contraMultiplier × pressureMultiplier`.

### Visual Design System

The application features a high-end, professional aesthetic using Penn's navy and gold brand palette, with a light-mode only design, custom CSS brand tokens, and a layered "ambient atmosphere" background.

### Tutorial Video

A short, animated tutorial (`/penn-fit-tutorial/`) built with `framer-motion` and `lucide-react` guides users through the fitting process.

### CPAP Resupply Automation System

A separate CPAP Resupply Automation system within the monorepo provides automated patient outreach for admins.

*   **Components:** `artifacts/resupply-api/` (Express API), `artifacts/resupply-worker/` (pg-boss background worker), `artifacts/resupply-dashboard/` (React admin console).
*   **Database:** Resupply tables are under the `resupply` schema with PHI columns encrypted using `pgcrypto`. Versioned migrations are used for schema management.
*   **Readiness Probe:** `/readyz` endpoint for health checks, verifying database and queue schema readiness.
*   **Admin Authentication:** Uses Clerk with a distinct email allowlist (`RESUPPLY_ADMIN_EMAILS`). The legacy variable name `RESUPPLY_OPERATOR_EMAILS` is read as a fallback (with a one-time deprecation warning) so existing deployments keep working until the env var is rotated.
*   **Operational Hardening:** Includes log redaction, `pino` flush-on-exit, and CORS configuration.
*   **Voice (Outbound Calls):** Integrates Twilio Voice and OpenAI's Realtime API for automated patient calls, with on-device patient identity verification and tool dispatching.
*   **Messaging (SMS + Email):** Supports two-way SMS via Twilio and email via SendGrid. Patient lookup uses an HMAC-based `phone_lookup` table for privacy. Features a hybrid scripted and AI reply router for inbound messages and interactive email links.
*   **Admin Dashboard:** Provides a full admin console with API endpoints for patient, conversation, episode, and audit log management, with server-side PHI decryption and strict pagination. Admins can create new customers from the patients page via a "+ New customer" modal that posts to `POST /patients` (PHI encrypted server-side, duplicate `pacware_id` returns 409, all create attempts are audited with field-name lists only — never PHI values). Six gap-closing capabilities let admins act on patients, not just observe them:
    *   **In-thread reply** (`POST /conversations/:id/reply`, channel-aware via `replyInConversation` in `@workspace/resupply-reminders`): admins can SMS or email the patient on the existing conversation; closed conversations 409, missing messaging config 503.
    *   **Send-now outreach** from the patient detail action bar — reuses `sendSmsReminder` / `sendEmailReminder` / `placeVoiceCall` against the most recent open episode.
    *   **Patient case-notes** (`patient_notes` table, body column encrypted via `pgcrypto`, append-only). `GET /patients/:id/notes` (paginated, newest-first) and `POST /patients/:id/notes` (1..4000 chars). Audit metadata is structural only (count, body_length) — never note text.
    *   **Prescription create + status PATCH** (`POST /patients/:id/prescriptions`, `PATCH /prescriptions/:rxId`). PATCH is restricted to status transitions (`active → expired | revoked`); clinical fields (SKU, cadence, prescriber, diagnosis) are immutable post-create for provenance — to "edit" a prescription, admins add a new one and mark the old one expired.
    *   **Quick pause/resume/close** via the existing `PATCH /patients/:id` extended to accept `status: "active" | "paused" | "closed"`. The eligibility scan in `scanForDueReminders` already suppresses non-active patients, so flipping the bit is the canonical knob.
    *   **CSV bulk import** (`POST /patients/import-csv`, max 500 rows per request, server JSON-only). The dashboard parses CSV client-side with `papaparse`, validates rows, chunks at 250 rows/batch, and renders a per-batch summary with a downloadable error CSV. Duplicate `pacware_id` is reported as `skippedDuplicates` (not failure). One audit row per batch with `{created, skipped_duplicates, error_count, row_count}` — no PHI.
*   **Admin productivity (Batch A — April 2026):** Five small/high-leverage admin wins shipped together:
    *   **Patient search by phone or email** (`GET /patients?search=...`): when the search string normalizes to a valid E.164 phone via `normalizeE164`, the route uses an `IN (SELECT patient_id FROM phone_lookup WHERE hmac_phone = ...)` subquery for an exact O(1) match (the encrypted phone column has a random IV so equality search isn't possible without the HMAC index). Otherwise the existing decrypt+ILIKE union now also covers `decrypt(email)` so admins can search by name, pacware id, or partial email in the same box. Falls back to text search if `RESUPPLY_PHONE_HMAC_KEY` is unset. The two patient-insert paths (`POST /patients`, `POST /patients/import-csv`) backfill `phone_lookup` immediately after the row INSERT (non-fatal on failure) so freshly-created patients are findable by phone before any outbound SMS lazily populates the index.
    *   **Reply templates** (frontend-only `lib/reply-templates.ts`): six hardcoded responses (confirm, decline, need-rx, shipping-eta, address-check, callback) with a `{firstName}` placeholder substituted client-side from the conversation's `patientFirstName`. Channel-aware (SMS templates kept short, email longer). The `ReplyComposer` exposes a small "Insert template" select above the textarea — empty textarea replaces, populated textarea appends.
    *   **Reply draft autosave** (`lib/use-draft-autosave.ts`): localStorage-backed hook keyed `reply-draft:${conversationId}` with 250ms debounce. Drafts hydrate on `ReplyComposer` mount, clear on successful send. To avoid leaving PHI-bearing half-typed replies on disk across admin sessions, both sign-out paths (`AppShell` chip + `NotAuthorizedPage` button) call `clearAllDrafts()` BEFORE invoking Clerk `signOut`. Server-side optimistic concurrency / multi-tab cross-admin scoping is deferred to Batch B.
    *   **Undo close-patient** (`PatientActionBar`): closing a patient now surfaces an inline gold-bordered banner ("Patient closed. Reopen? (Xs)") with an 8-second countdown and Undo button. Undo PATCHes status back to `active`. Race guard: if the latest `patient.status` prop is no longer `closed` at click time (i.e. another admin or another tab mutated it inside the 8s window), Undo refuses to clobber and surfaces "Patient was already updated elsewhere". Server-side If-Match guards belong with the Batch B idempotency work.
    *   **Notes search** (`NotesTab`): client-side substring filter input above the notes list (case-insensitive on decrypted note bodies). Shows "(N of M)" count when filtered, plain count otherwise. Notes are paginated to 50 server-side so an in-memory filter is sufficient for v1; deeper history would promote this to `?search=` server-side.
*   **Admin reliability (Batch B — April 2026):** Four backend-leaning admin durability wins shipped together:
    *   **Idempotency keys on write endpoints** (`resupply.idempotency_keys` table + `withIdempotency(endpoint)` middleware). Optional `Idempotency-Key` request header (back-compat with callers that don't send one). On hit + matching `request_hash` → replay the stored 2xx response; on hit + different hash → 422 `idempotency_key_reused`; on miss → run the handler, then asynchronously persist the captured `res.json(...)` body via `INSERT … ON CONFLICT DO UPDATE` on `res.on("finish")`. Persistence runs inside an async IIFE (the drizzle query builder is a thenable, not a Promise) and any failure logs `WARN` but never affects the already-sent response. 24h TTL on rows. Wired into `POST /patients`, `POST /patients/import-csv`, `POST /conversations/:id/reply` (no `send-now-*` endpoints exist in this codebase).
    *   **Optimistic concurrency on `PATCH /patients/:id`**: request body now accepts optional `expectedUpdatedAt` (ISO 8601). When supplied, the UPDATE gates on `date_trunc('milliseconds', updated_at) = $expected` (the `date_trunc` is required because Postgres `timestamptz` is microsecond precision but `pg` parses values back as JS `Date` at millisecond precision — an `eq` without truncation would 409 every time on rows whose `updated_at` carries µs). New writes also `set updated_at = date_trunc('milliseconds', now())` so subsequent round-trips match exactly. On 0 rows affected we re-`SELECT id` to disambiguate `404 not_found` (patient deleted) from `409 stale_patient` (someone else updated it). The dashboard's `PatientActionBar`, undo-close timer, and `SettingsCard` now all read `patient.updatedAt` and send it; on 409 they show a toast and refetch.
    *   **Bulk patient status actions** (`POST /patients/bulk-status`, max 100 ids per call): single `UPDATE … WHERE id = ANY(...)` with `RETURNING` so partial failures (`not_found`) are reported per-id without N round trips. Dedupes ids client-side and server-side. Writes one `patient.update` audit row per successful update plus one `patient.bulk_status_change` summary row with `{requested_status, updated_count, failed_count, requested_count}`. Dashboard exposes a row-checkbox column (with header indeterminate state) and a sticky gold-bordered action bar at the top of the patients page: "Resume N / Pause N / Close N / Clear selection". The selection set auto-prunes to currently-visible rows when filters/page change so admins can never act on rows they aren't looking at.
    *   **CSV export of patients** (`GET /patients/export.csv`, same `?status=`/`?search=` filters as the list endpoint, capped at 5000 rows v1). Uses the SQL-side `decrypt(...)` helper inside the SELECT so plaintext PHI is materialized exactly once (not buffered as bytea + plaintext in app memory). Fetches `MAX_ROWS+1` and slices, setting `X-Truncated: true` when the sentinel row is present — avoids a separate COUNT(*) query. RFC 4180 escaping (`csvEscape` doubles embedded quotes and wraps cells containing `,` / `"` / newlines). `Cache-Control: no-store` and `Content-Disposition: attachment; filename="patients-export.csv"`. Audit row records `{row_count, status_filter, search_filter_present, truncated}` only — never the search string itself or any cell contents. Dashboard "Export CSV" button does a manual `fetch` with the Clerk `Bearer` token (the dashboard uses bearer auth, not cookies, so a plain `<a href>` wouldn't carry credentials), then triggers a blob download via `URL.createObjectURL`.
*   **Reminder Eligibility Engine:** Per-patient overrides (`patients.cadence_override_days`, `patients.channel_preference`, `patients.insurance_payer`) and a global rules engine (`resupply.frequency_rules` — matched by SKU prefix, payer, and tenure window with priority ordering) determine reminder cadence and channel. Resolution lives in `@workspace/resupply-domain`'s `resolveOutreachPlan` (zero DB deps) so both the worker and the dashboard preview agree. Admins manage rules at `/rules` and per-patient overrides on the patient detail page; a chronological Timeline tab on the patient detail page merges episode, message, and fulfillment events into one feed.

## External Dependencies

*   **SendGrid:** Used for sending order fulfillment emails and resupply email reminders.
*   **MediaPipe Face Mesh:** Google's on-device facial landmark detection solution for privacy-first measurements.
*   **AWS:** Deployment target, providing HIPAA-compliant infrastructure.
*   **PostgreSQL:** Database for persisting orders, usage events, admin audit logs, and all resupply system data.
*   **Clerk:** Third-party authentication service for admin and admin access control.
*   **Twilio:** Used for CPAP Resupply Automation outbound voice calls and two-way SMS messaging.
*   **OpenAI:** Utilized by the CPAP Resupply Automation system for Realtime API (voice conversation) and chat-completions (SMS intent classification).