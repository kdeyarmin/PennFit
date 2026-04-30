# PennPaps — Penn Home Medical Supply

## Overview

PennPaps is a privacy-first web application designed to simplify CPAP mask selection and ordering. It uses on-device facial measurements and a clinical questionnaire to provide personalized mask recommendations from its product catalog. The application supports both insurance-based and cash-pay customers, aims to improve patient adherence, and includes an internal CPAP Resupply Automation system for patient outreach and management. The project envisions PennPaps as a full storefront for CPAP supplies, encompassing fitting, shopping, and resupply services.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log order request bodies in the application logger (treat every log line as world-readable).

## System Architecture

The PennPaps application employs a privacy-first, stateless architecture, prioritizing on-device processing for sensitive data and secure handling of persistent information.

### Privacy and Data Handling

Facial image processing occurs entirely on-device using MediaPipe Face Mesh; only numeric measurements are transmitted to the backend. Camera images and video streams are never uploaded or stored. Order data, including PHI, is securely persisted in PostgreSQL.

### Technical Stack

The project utilizes a monorepo with `pnpm workspaces`, `Node.js v24`, `TypeScript v5.9`. The API is built with `Express 5` and `Zod` for validation. The frontend uses `React`, `Vite`, `Tailwind CSS`, and `Wouter`. `Drizzle ORM` with `node-postgres` manages database interactions. `Clerk` handles admin and customer authentication.

### Application Flow

The user journey includes Home, Consent, Capture (facial scan), Measure (on-device processing), Questionnaire, Results (mask recommendations), Order (intake form), Order Success, Masks (catalog browser), and Privacy policy. Mask recommendations are generated using a weighted scoring formula.

### Visual Design System

The application features a professional aesthetic with Penn's navy and gold brand palette, a light-mode only design, custom CSS brand tokens, and a layered "ambient atmosphere" background. An animated tutorial guides users. Mobile responsiveness is a key design consideration, with careful attention to small screen layouts and touch targets. The site is optimized for performance, SEO, and PWA capabilities.

### CPAP Resupply Automation System

A separate internal system automates patient outreach using an `Express API`, `pg-boss` background worker, and a `React admin console`. It uses a `resupply` schema with encrypted PHI columns and `Clerk` for admin authentication. Outreach integrates `Twilio` for voice calls and two-way SMS, and `SendGrid` for email. The Admin Dashboard offers comprehensive tools for patient, conversation, episode, and audit log management.

### Cash-Pay Shop & Customer Accounts

A customer-facing `/shop` allows direct purchase of CPAP supplies via `Stripe Hosted Checkout`. `Stripe` is the source of truth for products and prices. The frontend manages product display and a localStorage-backed cart. The backend handles `Stripe` integration for checkout sessions and webhooks. Signed-in customers can save shipping information, view saved card crumbs, and reorder past purchases. `Clerk` provides customer identity, linking to `Stripe` customer IDs. The shop supports "Subscribe & Save" for recurring purchases.

### Cart Abandonment Nudge

Signed-in shop visitors who leave items in their cart for more than 24 hours receive a single email reminder with a deep link to re-hydrate the cart. This uses a `shop_abandoned_carts` table and SendGrid for delivery.

### Customer Product Reviews

Signed-in customers can leave one pre-moderated review per product (1–5 stars + optional title/body). Reviews appear publicly only after admin approval. Edits reset the moderation status.

### Admin Console Plain-English Pass

The admin console provides a UX-overhaul layer for non-technical operators, including friendly labels for funnel steps and audit actions, improved dashboard summaries, and clear navigation.

### Admin Team Management (Self-Service)

Admins can invite, promote, demote, and remove teammates from inside the cpap-fitter admin console at `/admin/users` ("Team" nav item, admin-only). Implemented via Clerk invitations + a `pennRole` claim on Clerk `publicMetadata`, with no schema changes (audit rows go to the existing `admin_audit_log` table). The `requireAdmin` middleware resolves access in priority order: `PENN_ADMIN_EMAILS` env → `PENN_AGENT_EMAILS` env → `publicMetadata.pennRole` → 403. The env allowlists are intentionally retained as a permanent recovery / bootstrap path and are surfaced read-only on the Team page. A self-revoke / self-demote lockout guard prevents the active admin from removing themselves. Mutating routes (invite / change role / revoke / cancel invite) require `requireAdminOnly`; the GET roster is available to agents read-only.

### Auth-Provider Branding & Identifier Convention

User-facing strings, comments, and internal DTO field names no longer say "Clerk" — the codebase refers to it as "the auth provider" or just "auth". The user-visible terminology is "team / teammates / members" instead of "Clerk users". Identifier-rename cascade applied across the resupply stack and the cpap-fitter admin surface: `clerkId → userId`, `adminClerkId → adminUserId`, `authorClerkId → authorUserId`, `clerkUsers → members`, `AdminTeamClerkUser → AdminTeamMember`, `ClerkUserRow → TeamMemberRow`, `req.adminClerkId → req.adminUserId`. The OpenAPI spec (`lib/resupply-api-spec/openapi.yaml`) and its generated client (`lib/resupply-api-client/src/generated/`) use the new names; regenerate with `pnpm --filter @workspace/resupply-api-spec run codegen` after spec edits.

The following are intentionally left as-is because they are SDK-bound (renaming them would change behavior, not branding): npm package names `@clerk/*`, exports `ClerkProvider` / `useClerk` / `clerkClient` / `clerkMiddleware`, the `Clerk-Proxy-Url` and `Clerk-Secret-Key` HTTP headers (Clerk SDK protocol), the `*.clerk.com` CSP whitelist, the `@layer clerk` CSS layer, and any `console.log("Clerk: …")` lines emitted by the SDK at runtime. These cannot be removed without replacing the auth provider entirely.

**Drizzle JS-field rename convention**: when renaming an internal identifier whose underlying Postgres column is named `*_clerk_id` (e.g. `admin_clerk_id`, `operator_clerk_id`, `author_clerk_id`), only the JS property is renamed; the column-name string passed to `text("…")` stays unchanged. Drizzle binds via the column-name string, so this is wire-compatible. Renaming the column would require a hand-authored migration per ADR 003 (we never `db:push` schema changes against production data). The convention is documented in JSDoc on `lib/db/src/schema/admin-audit-log.ts`, `lib/resupply-db/src/schema/audit-log.ts`, and `lib/resupply-db/src/schema/patient-notes.ts`.

### Mobile Fit-Flow Stepper

A `<FitFlowStepper>` component provides visual progress indication for the mask fitting flow, adapting its display for mobile and desktop screens.

### Prescription Document Attachments (Admin)

Admins can attach a single prescription document (PDF or image, ≤10MB) per prescription row via private GCS. This includes presigned PUT URLs, server-side validation, and secure retrieval/deletion. An asynchronous sweep job cleans up orphaned prescription attachment files.

### Customer-Facing Reminder Subscriptions

A self-serve, opt-in reminder system at `/reminders` allows customers to sign up for email notifications when CPAP supplies are due for replacement. This system is separate from the internal Resupply Automation and includes a `reminder_subscriptions` table, public API endpoints for management, and an admin dispatcher.

### Customer 360 (Admin)

A "Customers" section in the cpap-fitter admin (`/admin/customers` and `/admin/customers/:userId`) gives staff a single-pane view of every shop customer: search/sort/paginate the directory, then drill into a profile that shows lifetime stats, recent orders, subscriptions, abandoned cart, and product reviews. From a paid order, an admin can click "Reorder for customer" to generate a Stripe Checkout Session (mode `payment`) prefilled with the prior order's line items; the dashboard returns the checkout URL with Copy and Open buttons so the admin can share it with the customer out-of-band (email/SMS).

Architecture notes:
- Backend lives in `artifacts/resupply-api/src/routes/admin/customers.ts` (mounted at `/resupply-api/admin/shop/customers/*`). Frontend pages call across the shared proxy via `resupplyAdminFetch` in `artifacts/cpap-fitter/src/lib/admin-api.ts`.
- The new endpoints are intentionally NOT in the OpenAPI spec — this matches the local convention used by the other `/admin/shop/*` endpoints (orders, reviews, inventory), which both dashboards consume via raw fetch.
- These endpoints log via `req.log` only; no `audit_log` writes. Shop is not patient-PHI surface, so it follows the same posture as the other `/admin/shop/*` routes (audit_log is reserved for `/patients/*` PHI operations).
- PHI posture: list responses redact email via `redactEmail()`; the detail endpoint returns full email/address. Logs only carry `userId`, counts, and admin identity — never customer email or address.
- Cross-API admin allowlist caveat: the cpap-fitter admin guard reads `PENN_ADMIN_EMAILS` (api-server) but the new endpoints are gated by `RESUPPLY_ADMIN_EMAILS` (resupply-api). For an account to actually use the Customers page in any environment (dev, preview, or prod), its email must be present in BOTH allowlists.

## External Dependencies

*   **SendGrid:** For emails (order fulfillment, resupply reminders, abandoned cart, review moderation).
*   **MediaPipe Face Mesh:** Google's on-device facial landmark detection.
*   **AWS:** Provides HIPAA-compliant deployment infrastructure.
*   **PostgreSQL:** Primary database.
*   **Clerk:** Authentication service for admins and customers.
*   **Twilio:** For outbound voice calls and two-way SMS messaging in resupply.
*   **OpenAI:** Used by Resupply Automation for Realtime API (voice) and chat completions (SMS intent).
*   **Stripe:** For payment processing, managing the cash-pay shop, and product/price management.
*   **Google Cloud Storage (GCS):** For secure storage of prescription document attachments.