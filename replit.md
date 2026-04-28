# Penn Fit — CPAP Mask Fitter

## Overview

Penn Fit is a web application designed for Penn Home Medical Supply, LLC, to assist patients in selecting the most suitable CPAP mask. The application prioritizes user privacy through on-device facial measurements and combines this with a clinical questionnaire to provide personalized, justified mask recommendations from Penn's product catalog. It also facilitates order placement and adheres to Penn's brand guidelines, including an animated tutorial for user guidance.

**Key Capabilities:**

*   **Privacy-First Facial Measurement:** On-device processing of facial images for measurements, without transmitting or storing sensitive image data.
*   **Clinical Questionnaire:** Gathers patient data for refined mask recommendations.
*   **Personalized Mask Recommendations:** Delivers a ranked list of masks with justifications based on facial fit and clinical needs.
*   **Order Placement:** Securely submits orders to Penn Home Medical Supply via a stateless API.
*   **Brand Alignment:** Incorporates Penn's distinct visual design system.
*   **Tutorial:** Guides users through the fitting process with an animated video.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log order request bodies in the application logger (treat every log line as world-readable).

## System Architecture

The Penn Fit application employs a privacy-first, stateless architecture, emphasizing on-device processing for sensitive data and secure handling of persistent information.

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

A separate CPAP Resupply Automation system within the monorepo provides automated patient outreach for operators.

*   **Components:** `artifacts/resupply-api/` (Express API), `artifacts/resupply-worker/` (pg-boss background worker), `artifacts/resupply-dashboard/` (React operator console).
*   **Database:** Resupply tables are under the `resupply` schema with PHI columns encrypted using `pgcrypto`. Versioned migrations are used for schema management.
*   **Readiness Probe:** `/readyz` endpoint for health checks, verifying database and queue schema readiness.
*   **Operator Authentication:** Uses Clerk with a distinct email allowlist (`RESUPPLY_OPERATOR_EMAILS`).
*   **Operational Hardening:** Includes log redaction, `pino` flush-on-exit, and CORS configuration.
*   **Voice (Outbound Calls):** Integrates Twilio Voice and OpenAI's Realtime API for automated patient calls, with on-device patient identity verification and tool dispatching.
*   **Messaging (SMS + Email):** Supports two-way SMS via Twilio and email via SendGrid. Patient lookup uses an HMAC-based `phone_lookup` table for privacy. Features a hybrid scripted and AI reply router for inbound messages and interactive email links.
*   **Operator Dashboard:** Provides a full operator console with API endpoints for patient, conversation, episode, and audit log management, with server-side PHI decryption and strict pagination.
*   **Reminder Eligibility Engine:** Per-patient overrides (`patients.cadence_override_days`, `patients.channel_preference`, `patients.insurance_payer`) and a global rules engine (`resupply.frequency_rules` — matched by SKU prefix, payer, and tenure window with priority ordering) determine reminder cadence and channel. Resolution lives in `@workspace/resupply-domain`'s `resolveOutreachPlan` (zero DB deps) so both the worker and the dashboard preview agree. Operators manage rules at `/rules` and per-patient overrides on the patient detail page; a chronological Timeline tab on the patient detail page merges episode, message, and fulfillment events into one feed.

## External Dependencies

*   **SendGrid:** Used for sending order fulfillment emails and resupply email reminders.
*   **MediaPipe Face Mesh:** Google's on-device facial landmark detection solution for privacy-first measurements.
*   **AWS:** Deployment target, providing HIPAA-compliant infrastructure.
*   **PostgreSQL:** Database for persisting orders, usage events, admin audit logs, and all resupply system data.
*   **Clerk:** Third-party authentication service for admin and operator access control.
*   **Twilio:** Used for CPAP Resupply Automation outbound voice calls and two-way SMS messaging.
*   **OpenAI:** Utilized by the CPAP Resupply Automation system for Realtime API (voice conversation) and chat-completions (SMS intent classification).