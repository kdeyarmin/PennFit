# PennPaps — Penn Home Medical Supply

## Overview

PennPaps is a web application designed to help patients select the most suitable CPAP mask. It offers a privacy-first approach by utilizing on-device facial measurements, combined with a clinical questionnaire, to provide personalized and justified mask recommendations from the PennPaps product catalog. The application also facilitates order placement, adheres to PennPaps brand guidelines, and includes an animated tutorial for user guidance. The project aims to streamline the CPAP mask selection process, improve patient adherence, and offer a robust solution for both insurance-based and cash-pay customers.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log order request bodies in the application logger (treat every log line as world-readable).

## System Architecture

The PennPaps application operates on a privacy-first, stateless architecture, prioritizing on-device processing for sensitive data and secure handling of persistent information.

### Privacy and Data Handling

Facial image processing is performed entirely on-device using MediaPipe Face Mesh, with only numeric measurements transmitted to the backend. Sensitive data like camera images and video streams are never uploaded or stored. Order data, including PHI, is securely persisted in PostgreSQL.

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
*   **Database:** Drizzle ORM + node-postgres for `orders`, `usage_events`, `admin_audit_log`, and `resupply` schema tables.
*   **Authentication:** Clerk for admin authentication.

### Application Flow

The user journey encompasses Home, Consent, Capture (facial scan), Measure (on-device processing), Questionnaire, Results (mask recommendations), Order (intake form), Order Success, Masks (catalog browser), and Privacy policy.

### Recommendation Scoring

Mask recommendations are generated using a combined score: `(typeScore × 0.60 + fitScore × 0.40) × contraMultiplier × pressureMultiplier`.

### Visual Design System

The application features a professional, high-end aesthetic, utilizing Penn's navy and gold brand palette, a light-mode only design, custom CSS brand tokens, and a layered "ambient atmosphere" background. An animated tutorial guides users through the fitting process.

### CPAP Resupply Automation System

A separate, internal CPAP Resupply Automation system manages automated patient outreach, including:

*   **Components:** Express API, pg-boss background worker, React admin console.
*   **Database:** `resupply` schema with PHI columns encrypted using `pgcrypto`.
*   **Admin Authentication:** Clerk with an email allowlist.
*   **Outreach:** Integrates Twilio Voice for automated calls (with OpenAI's Realtime API for real-time conversation) and two-way SMS, and SendGrid for email.
*   **Admin Dashboard:** Provides comprehensive tools for patient, conversation, episode, and audit log management, including in-thread replies, send-now outreach, patient case notes, prescription management, patient status actions (pause/resume/close), and CSV bulk import/export. Key features include patient search by phone or email, reply templates, draft autosave, and optimistic concurrency for updates.

### Patient Education

The `/learn` hub links to longer-form, single-purpose sub-pages:
- `/learn/replacement-schedule` — full per-item cadences for cushions, tubing, filters, headgear, and chambers, with overdue self-check.
- `/learn/device-setup` — new-patient step-by-step guide for setting up a CPAP or BiPAP: 7-step initial setup, first-night expectations, daily/weekly/monthly care, troubleshooting (leaks, dry mouth, aerophagia, claustrophobia, pressure intolerance), BiPAP-specific notes, and "when to call us vs. your doctor". Surfaced from `/learn` and from `/order-success` so newly-purchased customers see it immediately after checkout.

### Site-Wide Editorial Voice (Storefront Reframe)

The user-facing copy treats PennPaps as a full storefront, not just a mask fitter. Three canonical entry points are surfaced everywhere — **Get fitted for a mask** (`/consent`), **Shop CPAP supplies** (`/shop`), **My account** (`/account`) — with a unified CTA lexicon used across `home.tsx`, `learn.tsx`, `faq.tsx`, `not-found.tsx`, and `order-success.tsx`. Hero framing is *"Your CPAP, made simple. Fit. Shop. Resupply."* and the home page leads with a "Three ways to start" 3-card section before the legacy fitter feature grid (now scoped under a "The Mask Fitter" heading). The "How It Works" page and nav label are surfaced as **Virtual Mask Fitter** (URL preserved at `/how-it-works`). Trust claims stay factual (e.g., "~3-minute fitting", "On-device face capture") and avoid plan-dependent guarantees like "$0 out of pocket". `index.html` title/OG describe the full fitter + shop + resupply scope.

### Mobile Responsiveness

Most patients reach the store from a phone, so every customer-facing surface is verified at 320–390px widths. Notable patterns: `layout.tsx` provides a sticky header (`h-16 md:h-20`) with a hamburger drawer below `md` and includes the cart icon + user menu inline on mobile; long-form pages (e.g. `/learn/replacement-schedule`) ship a desktop `<table>` and a parallel mobile `<dl>` card list rather than horizontally scrolling tables; the home hero scales `text-4xl → sm:text-5xl → md:text-6xl → lg:text-7xl` and decorative eyebrow rails are hidden below `sm` to keep the four-line headline + CTAs above the fold on iPhone-class screens. Customer-facing CTAs use full-width tap targets (≥48px) on mobile via the standard `Button size="lg"` class. Admin pages intentionally keep their `overflow-x-auto` data tables — they are internal-only. The viewport meta tag deliberately omits `maximum-scale` / `user-scalable=no` so low-vision patients can pinch-zoom (WCAG 2.1 SC 1.4.4).

### Site Quality (SEO, PWA, Performance)

The cpap-fitter `public/` directory ships the production-grade asset bundle expected of a real storefront: `robots.txt` (allows public pages, disallows admin/auth/funnel paths, points at the sitemap), `sitemap.xml` (canonical pages with `https://pennpaps.com` URLs and per-section change frequencies), `manifest.webmanifest` + brand PNG icons (`apple-touch-icon.png` 180×180, `icon-192.png`, `icon-512.png`, `favicon-32.png`) so the site installs as a PWA, and a JSON-LD `MedicalBusiness` block in `index.html <head>` so search engines understand PennPaps is the online storefront for Penn Home Medical Supply. Inter is **self-hosted** under `public/fonts/` (rsms/inter v4 woff2, weights 400/500/600/700, ~115KB each) with `@font-face` declarations in `index.css` and `font-display: swap`; the most-used weights (Regular, SemiBold) are `<link rel="preload">`-ed. There are no third-party network requests for typography. Heaviest product images are stored as 800×800 WebP under `public/products/` (~22–58KB each); both `scripts/seed-stripe-products.ts` and `resupply-api/lib/stripe/preview-catalog.ts` reference the canonical filenames. Account address fields use proper `autoComplete` tokens (`name`, `address-line1/2`, `address-level1/2`, `postal-code`) so iOS/Android contact autofill works.

The page-level CSP (`<meta http-equiv>` in `index.html`) is same-origin for everything except the Clerk auth domains; fonts are now `font-src 'self' data:` (no Google hosts). `'unsafe-inline'`/`'unsafe-eval'` remain on `script-src` because the Clerk SDK and Vite both require them — documented inline. Note: meta-tag CSP cannot reliably enforce `frame-ancestors`; if clickjacking protection becomes a hard requirement, move CSP to an HTTP response header on the production deploy.

### Cash-Pay Shop

A customer-facing `/shop` offers CPAP supplies for direct purchase via Stripe Hosted Checkout, designed to coexist with the insurance flow and provide an "Use insurance" escape hatch.

*   **Architecture:** Stripe acts as the source of truth for products and prices, with the API caching product lists. A local `resupply.shop_orders` table tracks session status without storing PHI.
*   **Frontend:** Manages category-grouped product display, a localStorage-backed cart with cross-tab sync, and checkout success/cancel pages.
*   **Backend:** Handles product retrieval (cached), Stripe Checkout session creation, and Stripe webhook processing. Rate limiting is implemented for abuse mitigation.
*   **Product catalog:** Each SKU carries a real manufacturer name, exact manufacturer model number (e.g. ResMed AirFit P10 Mask = `#62932`), a product photo, and a long description. The Stripe seed script (`pnpm --filter @workspace/scripts run seed:shop`) writes `metadata.manufacturer` / `metadata.model_number` to each Stripe Product and uploads image URLs from `SHOP_PUBLIC_BASE_URL` so production cards render the same imagery as preview mode. Bundle cards reference component model numbers in their contents list (e.g. "1× ResMed AirFit N20 cushion · medium (#63551)") so patients can verify exactly what they're buying.
*   **Image resolution:** Product `imageUrl` is either an absolute Stripe-CDN URL (production) or a path under `cpap-fitter/public/products/` (preview mode). The `resolveProductImage()` helper in `shop-api.ts` handles both cases by prepending `import.meta.env.BASE_URL` when the path is relative, so images work whether the cpap-fitter is mounted at `/` or under a path prefix.

### Customer Accounts (Shop)

Signed-in shoppers can save shipping info, see their saved card crumbs, and reorder past purchases — coexisting with anonymous guest checkout.

*   **Identity:** Clerk (the same provider used for admin). Patient sign-in uses `?redirect=` to round-trip back to wherever the user came from (e.g. `/shop/cart` → sign-in → `/shop/cart`); admin links keep redirecting to `/admin` for backward compatibility.
*   **Storage:** New `resupply.shop_customers` table keyed by `clerk_user_id` holds the Stripe Customer ID, default shipping address (jsonb), and saved card display crumbs (brand/last4/exp). Card data itself stays in Stripe — we never see PANs. `shop_orders` gained a `clerk_user_id` column linking each order to the buyer (NULL for guests).
*   **Stripe Customer mapping:** `getOrCreateStripeCustomer` lazily creates a Stripe Customer on first checkout, with an idempotency key scoped to the Clerk user ID to prevent duplicates under race conditions.
*   **Account page (`/account`):** Editable name + shipping address (works in preview mode without Stripe), saved card display, recent orders with one-click "Reorder" buttons that POST to `/shop/me/quick-checkout` and bounce to a fresh Stripe Hosted Checkout session pre-attached to the Customer.
*   **Express checkout:** When a signed-in user with a saved card opens the cart, a prominent "Express checkout — pay with Visa ••••4242" button appears above the standard checkout button. Powered by Stripe's `payment_method_collection: 'if_required'` — the user sees a single tap on the Stripe page.
*   **Checkout integration:** The standard `/shop/checkout` is now auth-aware: signed-in users get their Customer attached automatically, with `setup_future_usage: 'off_session'` so the card from this purchase becomes saved-on-file for next time. Guests still check out anonymously.
*   **Webhook sync:** `checkout.session.completed` fans out to a `syncCustomerAfterCheckout` step that re-stamps `clerk_user_id` on the order, refreshes the saved card crumbs from the Customer's default payment method, and backfills the saved shipping address only if the user hasn't set one explicitly (never clobbers a deliberate edit).

## External Dependencies

*   **SendGrid:** For order fulfillment emails and resupply email reminders.
*   **MediaPipe Face Mesh:** Google's on-device facial landmark detection for privacy-first measurements.
*   **AWS:** Deployment target providing HIPAA-compliant infrastructure.
*   **PostgreSQL:** Primary database for all application and resupply system data.
*   **Clerk:** Authentication service for admin access and control.
*   **Twilio:** For CPAP Resupply Automation outbound voice calls and two-way SMS messaging.
*   **OpenAI:** Utilized by the CPAP Resupply Automation system for Realtime API (voice conversation) and chat completions (SMS intent classification).
*   **Stripe:** For payment processing and managing the cash-pay shop.