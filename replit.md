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

#### resupply-worker as a deployable artifact

The pg-boss worker (`artifacts/resupply-worker`) is registered as a standalone `kind = "api"` artifact (proxy slot `/__resupply-worker-internal`, internal-only). Production runs an `esbuild` bundle (`pnpm --filter @workspace/resupply-worker run build` → `node dist/index.mjs`) instead of `tsx`, mirroring the api-server / resupply-api pattern. A minimal `node:http` server inside the worker exposes `/_internal/healthz` (matched both bare and prefixed with `/__resupply-worker-internal`, since the shared proxy does not rewrite paths). The endpoint returns 503 until pg-boss has bootstrapped its `pgboss_resupply` schema AND every job handler has registered, then flips to 200. The deploy gate uses this as `[services.production.health.startup]`, which prevents a half-initialized deploy from going live.

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

### Shop Transactional Emails

Two customer-facing transactional emails close the loop on the cash-pay shop. Both are sent via SendGrid using the same brand styling (cream background + #c9a227 gold) as the cart-abandonment template, and both are idempotent at the database level under concurrency so Stripe re-deliveries, parallel webhook events, or accidental admin re-saves never duplicate.

**Atomic-claim idempotency model.** Both helpers use a single `UPDATE … SET stamp = now() WHERE id = $1 AND stamp IS NULL RETURNING …` to *claim* the right to send. Postgres serializes this row-level UPDATE, so even when `checkout.session.completed` and `checkout.session.async_payment_succeeded` arrive in parallel — or two admins click "save tracking" simultaneously — only one worker wins the row and proceeds to render+send. On any failure path (no recipient, SendGrid not configured, SendGrid 4xx/5xx, helper throw) the claim is *released* by writing the stamp back to NULL, so a Stripe re-delivery (or a manual admin re-save) can retry. This preserves at-most-once *successful* sends while still allowing one retry per failure.

- **Order confirmation** (`send-order-confirmation-email.ts`): triggered from the `checkout.session.completed` branch of `artifacts/resupply-api/src/lib/stripe/webhook-handler.ts`. After `markPaid` and `upsertOrderItemsFromSession`, the exported helper `sendOrderConfirmationIfFirst` performs the atomic claim on `confirmation_email_sent_at` and resolves the recipient as: linked `shop_customers.email_lower` → persisted `shop_orders.customer_email` → `session.customer_details.email`. The persisted column is captured at paid-time inside `markPaid` (lowercased) so guest checkouts have a stable on-row recipient even when the Stripe Session falls out of cache. Failures are logged but never thrown — Stripe must not retry the webhook because of an email outage. Subject: "Your PennPaps order is confirmed". customArgs: `{ kind: "shop_order_confirmation_v1", stripe_session_id }`.
- **Shipping notification** (`send-shipping-notification-email.ts`): triggered from `POST /admin/shop/orders/:orderId/tracking` in `artifacts/resupply-api/src/routes/admin/shop-orders.ts`. The route's tracking UPDATE both stamps the new `tracking_carrier`/`tracking_number` AND, in the same statement, conditionally clears `shipping_email_sent_at` via `CASE WHEN tracking_carrier IS DISTINCT FROM $new OR tracking_number IS DISTINCT FROM $new THEN NULL ELSE shipping_email_sent_at END`. (Postgres SET clauses see OLD row values, so this compares prior vs new.) The helper `sendShippingNotificationIfNew` then atomically claims on the (possibly cleared) timestamp — first send and genuine re-ships claim and send, identical re-saves find the timestamp non-null and short-circuit. Recipient resolution: linked `shop_customers.email_lower` → persisted `shop_orders.customer_email` → skip silently. Builds a public carrier-tracking URL via `getCarrierTrackingUrl()` (UPS / USPS / FedEx / DHL); unknown carriers fall back to bare number. customArgs: `{ kind: "shop_shipping_notification_v1", stripe_session_id }`.

Schema additions (additive, ADR 003 hand-authored migrations only):
- `lib/resupply-db/drizzle/0016_shop_orders_email_tracking.sql` — adds `confirmation_email_sent_at` and `shipping_email_sent_at` (both nullable TIMESTAMPTZ).
- `lib/resupply-db/drizzle/0017_shop_orders_customer_email.sql` — adds `customer_email` (nullable TEXT) for the guest-checkout fallback recipient.

Delivery feedback closes via the existing SendGrid Event Webhook at `POST /email/sendgrid-events` (ECDSA signature verification, mapping to `messages.delivery_status`). The smoke test at `routes/email/sendgrid-events.test.ts` pins the rejection-without-signature path and the processed/delivered/bounce/dropped/deferred → status mappings.

### Outbound email — single integration, single From address

Every outbound email across the entire monorepo is funneled through one place: `createSendgridClient()` in `lib/resupply-email/src/client.ts`. That client is the only direct consumer of the `@sendgrid/mail` SDK in the repo (enforced for resupply packages by Rules 12 + 13 in `scripts/check-resupply-architecture.sh`) and reads `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, and `SENDGRID_FROM_NAME` at call time. Operations sets `SENDGRID_FROM_EMAIL=info@pennpaps.com` so every outbound message — Penn Fit fulfillment, Penn Fit reminders, shop confirmation, shop shipping, cart abandonment, review moderation, resupply reminders, two-way reply — leaves the platform from the same canonical address.

Senders that go through the shared client:
- `lib/resupply-reminders/src/{send-email,reply}.ts` (resupply outreach)
- `artifacts/resupply-api/src/lib/order-emails/send-order-confirmation-email.ts`
- `artifacts/resupply-api/src/lib/order-emails/send-shipping-notification-email.ts`
- `artifacts/resupply-api/src/lib/cart-abandonment/send-cart-abandonment-email.ts`
- `artifacts/resupply-api/src/lib/messaging/review-moderation-email.ts`
- `artifacts/api-server/src/lib/{reminderEmail,orderEmail}.ts` (Penn Fit). These two were originally written before the shared client existed and used raw `fetch` to `https://api.sendgrid.com/v3/mail/send` plus their own `PENN_FROM_EMAIL` env var; the audit on 2026-04-30 migrated them to `createSendgridClient()` so there is no longer any path to SendGrid that bypasses the shared integration. Public function shapes (`sendReminderConfirmation`, `sendReminderManageLink`, `sendReminderDue`, `sendOrderToPenn`, `generateOrderReference`) are unchanged so all callers keep working.

There is no `nodemailer`, no SMTP, and no other raw HTTP path to SendGrid anywhere in the repo. The `mailto:info@pennpaps.com` links in `cpap-fitter/{privacy,terms}.tsx` and `resupply-dashboard/not-authorized.tsx` are user-facing contact links and not outbound email.

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