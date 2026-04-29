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

The user journey includes Home, Consent, Capture (facial scan), Measure (on-device processing), Questionnaire, Results (mask recommendations), Order (intake form), Order Success, Masks (catalog browser), and Privacy policy. Mask recommendations are generated using a weighted scoring formula: `(typeScore × 0.60 + fitScore × 0.40) × contraMultiplier × pressureMultiplier`.

### Visual Design System

The application features a professional aesthetic with Penn's navy and gold brand palette, a light-mode only design, custom CSS brand tokens, and a layered "ambient atmosphere" background. An animated tutorial guides users. Mobile responsiveness is a key design consideration, with careful attention to small screen layouts and touch targets. The site is optimized for performance, SEO, and PWA capabilities, including self-hosted fonts and optimized image assets.

### CPAP Resupply Automation System

A separate internal system automates patient outreach using an `Express API`, `pg-boss` background worker, and a `React admin console`. It uses a `resupply` schema with encrypted PHI columns and `Clerk` for admin authentication. Outreach integrates `Twilio` for voice calls and two-way SMS, and `SendGrid` for email. The Admin Dashboard offers comprehensive tools for patient, conversation, episode, and audit log management.

### Cash-Pay Shop & Customer Accounts

A customer-facing `/shop` allows direct purchase of CPAP supplies via `Stripe Hosted Checkout`. `Stripe` is the source of truth for products and prices. The frontend manages product display and a localStorage-backed cart. The backend handles `Stripe` integration for checkout sessions and webhooks. Signed-in customers can save shipping information, view saved card crumbs, and reorder past purchases. `Clerk` provides customer identity, linking to `Stripe` customer IDs.

The shop's product fetch is resilient to transient hiccups: on the very first failure of `/resupply-api/shop/products` it silently auto-retries once after ~1.2s before surfacing the friendly `<ShopLoadError>` card, which itself offers an in-place "Try again" button (no full reload required) plus a secondary "See how insurance works" escape hatch to `/insurance`. The 503/preview-mode "shop coming soon" branch is unchanged.

### Customer-Facing Reminder Subscriptions

A self-serve, opt-in reminder system at `/reminders` lets customers (no account required) sign up to be emailed when each CPAP supply is due for replacement. The flow is intentionally separate from the internal Resupply Automation system, which is admin/CSV driven and manages full insurance episodes — this storefront feature is a lightweight email-only nudge.

- **Storage:** A single `reminder_subscriptions` table in the main schema holds email, status (`active`/`unsubscribed`), a JSONB `items` array of `{sku, lastReplacedAt, intervalDays, nextDueAt}`, a 32-byte hex `manage_token`, and a `last_sent_at` timestamp. Email is unique-indexed (case-insensitive via lowercased writes); the manage token is the authentication mechanism for unauthenticated edits.
- **API:** Public routes under `/api/reminders` (POST to subscribe with honeypot `website` field; GET/PATCH/POST manage by `?token=`). Admin routes under `/api/admin/reminders` (list view + `send-due` dispatcher).
- **Dispatcher policy:** `POST /api/admin/reminders/send-due` finds active subscribers with at least one item whose `nextDueAt <= today`, respects a 7-day quiet period per subscriber (no spam), and does NOT auto-advance `lastReplacedAt` (sending a reminder is not evidence of replacement — the customer updates dates themselves from the manage page after they swap). Returns counts (`sent`, `skippedQuiet`, `skippedNoneDue`, `failed`) and a `sendgridConfigured` flag so the admin UI can warn when delivery is not actually wired up.
- **Email:** `reminderEmail.ts` mirrors `orderEmail.ts` — graceful skip when SendGrid is unconfigured. Confirmation on subscribe + due-reminder on dispatch, both with one-click manage links.
- **Frontend:** `/reminders` (signup form with per-SKU last-replaced/interval inputs and honeypot), `/reminders/manage?token=…` (edit/unsubscribe), and a `<SubscribeRemindersCta>` card placed on `/learn/replacement-schedule` (primary) and `/shop/checkout-success` (post-purchase nudge). Admin console gets a `/admin/reminders` page with a manual "Send due reminders now" button (cron wiring is future work).

## External Dependencies

*   **SendGrid:** For emails (order fulfillment, resupply reminders).
*   **MediaPipe Face Mesh:** Google's on-device facial landmark detection.
*   **AWS:** Provides HIPAA-compliant deployment infrastructure.
*   **PostgreSQL:** Primary database.
*   **Clerk:** Authentication service for admins and customers.
*   **Twilio:** For outbound voice calls and two-way SMS messaging in resupply.
*   **OpenAI:** Used by Resupply Automation for Realtime API (voice) and chat completions (SMS intent).
*   **Stripe:** For payment processing and managing the cash-pay shop.