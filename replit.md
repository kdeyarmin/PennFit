# PennPaps — Penn Home Medical Supply

## Git source of truth

**Canonical ref:** `main` on `https://github.com/kdeyarmin/PennFit` (the Replit remote-tracking name is `subrepl-3ppc2e03/main`).

**Why this exists:** in May 2026 the workspace, GitHub, and Replit's `gitsafe-backup` snapshots had drifted by ~150 commits across four divergent lines because no agent or human knew which surface was authoritative (see [`docs/git-state-2026-05-01.md`](./docs/git-state-2026-05-01.md) for the post-mortem). This rule prevents a repeat.

**Every agent session and human dev MUST do this at the start of work:**

```bash
# 1. Confirm working tree is clean (no uncommitted edits to lose)
git status

# 2. Pull the canonical ref and align local main to it
git fetch subrepl-3ppc2e03
git rev-list --count main..subrepl-3ppc2e03/main   # how many commits you're behind
# If clean and behind: align (destructive — only when status is clean)
git reset --hard subrepl-3ppc2e03/main
```

**Where new work lands:** push a feature branch and open a PR on `github.com/kdeyarmin/PennFit`. Do NOT commit directly to local `main` and let it drift again. The Replit Git pane has a "Push" action that creates the branch on the remote; finish the PR on github.com.

**The pre-commit hook warns** when local `main` is more than 10 commits behind `subrepl-3ppc2e03/main` (non-blocking — surfaces drift without breaking emergency commits). Bypass with `SKIP_HOOKS=1 git commit ...` or `--no-verify`.

## Overview

PennPaps is a privacy-first web application for personalized CPAP mask selection and ordering. It uses on-device facial measurements and a clinical questionnaire to recommend masks from its catalog. The application supports both insurance and cash-pay customers, aiming to improve patient adherence. It includes an internal CPAP Resupply Automation system for patient outreach and management. The vision is to create a comprehensive storefront for CPAP supplies, integrating fitting, shopping, and resupply services.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log order request bodies in the application logger (treat every log line as world-readable).

## System Architecture

The PennPaps application uses a privacy-first, stateless architecture with on-device processing for sensitive data.

### Privacy and Data Handling

Facial image processing is performed entirely on-device using MediaPipe Face Mesh; only numeric measurements are sent to the backend. Camera images and video streams are neither uploaded nor stored. Order data, including PHI, is securely stored in PostgreSQL.

### Technical Stack

The project is built as a monorepo using `pnpm workspaces`, `Node.js v24`, and `TypeScript v5.9`. The API uses `Express 5` with `Zod` for validation. The frontend is developed with `React`, `Vite`, `Tailwind CSS`, and `Wouter`. `Drizzle ORM` with `node-postgres` handles database interactions. Authentication is an in-house solution using `argon2id` and DB-backed `pf_session` cookies.

### Application Flow and Design

The user journey includes stages like Consent, Facial Scan, Questionnaire, Mask Recommendations, and Order placement. Mask recommendations are generated via a weighted scoring formula. The application features a professional design with Penn's brand colors (navy and gold), a light-mode only interface, custom CSS brand tokens, and an animated tutorial. It is optimized for mobile responsiveness, performance, SEO, and PWA capabilities.

### CPAP Resupply Automation System

The internal Resupply system automates patient outreach from a single `Express API` process (`artifacts/resupply-api`) that also boots an **in-process `pg-boss` worker** at startup (see `src/worker/index.ts`). The former separate `artifacts/resupply-worker` artifact was folded into the API in May 2026 — the workload is light (hourly reminder scan, weekly attachment sweep), the API's `/readyz` already gated on the same `pgboss_resupply.version` table the worker creates, and a single artifact is one fewer thing to deploy and monitor. Inbound SMS with media (MMS) is ingested inline by the webhook handler: each Twilio `MediaUrlN` is downloaded with HTTP basic auth (5s per-media timeout, 5MB cap, MIME allowlist of image/_ + application/pdf, max 10 attachments/message), uploaded to App Storage, and persisted as a `message_attachments` row keyed by `messages.id`. The dispatcher emits a `messaging.inbound.media_ingested` audit with counts only (no media URLs, no PHI). Attachments surface on `GET /conversations/:id` as `messages[].attachments[]` and stream through `GET /conversations/:id/messages/:messageId/attachments/:attachmentId` (admin-only, audit-logged, inline `Content-Disposition`); the admin conversation page renders image thumbnails with a click-to-zoom lightbox and non-image chips with MIME badge + size. The system integrates `Twilio` for voice calls and two-way SMS, and `SendGrid` for email. The Admin Dashboard (33 pages — patients, conversations, episodes, rules, audit logs, team, customers, returns) is mounted \*\*inside the same `cpap-fitter` SPA at `/admin/_`** so the project ships ONE customer-facing site at `pennfit.replit.app/`. Admin routes are gated by `useGetAdminMe`; admin auth pages live at `/admin/sign-in`, `/admin/forgot-password`, `/admin/reset-password`, `/admin/verify-email`(basePath`"/admin"`). Legacy `/resupply/_`URLs still route to the same artifact and SPA-redirect to`/admin/_`while preserving query strings (so existing`?token=…` bookmarks for password-reset/verify-email keep working). Admin theme tokens (`--penn-navy`, etc.) live in `src/admin.css`scoped under`.admin-root`so they do NOT clobber the storefront's brand tokens; every admin surface wraps its outer`<div>`with`className="admin-root"`.

### Cash-Pay Shop & Customer Accounts

A customer-facing `/shop` allows direct purchase of CPAP supplies using `Stripe Hosted Checkout`, with `Stripe` as the source of truth for products and prices. The frontend manages product display and a localStorage-backed cart. The backend integrates with `Stripe` for checkout and webhooks. Signed-in customers can save shipping information, view payment details, and reorder. The shop supports "Subscribe & Save" for recurring purchases.

### Admin Console and Team Management

The admin console provides a user-friendly interface with simplified labels and improved dashboard summaries for non-technical operators. Admins can manage team members (invite, promote, demote, remove) through a dedicated interface, with roles stored in `admin_users` and linked to `auth.users` tables.

### Outbound Email Management

All outbound emails across the monorepo are funneled through a single SendGrid client (`lib/resupply-email/src/client.ts`), ensuring a consistent `From` address (`info@pennpaps.com`) and centralized configuration. This includes order confirmations, shipping notifications, cart abandonment nudges, review moderation emails, and resupply reminders.

### Customer 360 (Admin)

A "Customers" section in the admin interface (`/admin/customers`) provides staff with a comprehensive view of each shop customer, including lifetime stats, orders, subscriptions, abandoned carts, and product reviews. Admins can reorder for customers directly from their profile.

## External Dependencies

- **SendGrid:** For all outbound email communications.
- **MediaPipe Face Mesh:** For on-device facial landmark detection.
- **AWS:** Production deployment infrastructure.
- **PostgreSQL:** Primary application database.
- **Twilio:** For outbound voice calls and two-way SMS messaging in resupply.
- **OpenAI:** Used by Resupply Automation for voice API and chat completions.
- **Stripe:** For payment processing, cash-pay shop management, and product/price data.
- **Google Cloud Storage (GCS):** For secure storage of prescription document attachments.
