# PennPaps — Penn Home Medical Supply

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

A separate internal system automates patient outreach using an `Express API`, `pg-boss` background worker, and a `React admin console`. It integrates `Twilio` for voice calls and two-way SMS, and `SendGrid` for email. The Admin Dashboard provides tools for managing patients, conversations, and audit logs.

### Cash-Pay Shop & Customer Accounts

A customer-facing `/shop` allows direct purchase of CPAP supplies using `Stripe Hosted Checkout`, with `Stripe` as the source of truth for products and prices. The frontend manages product display and a localStorage-backed cart. The backend integrates with `Stripe` for checkout and webhooks. Signed-in customers can save shipping information, view payment details, and reorder. The shop supports "Subscribe & Save" for recurring purchases.

### Admin Console and Team Management

The admin console provides a user-friendly interface with simplified labels and improved dashboard summaries for non-technical operators. Admins can manage team members (invite, promote, demote, remove) through a dedicated interface, with roles stored in `admin_users` and linked to `auth.users` tables.

### Outbound Email Management

All outbound emails across the monorepo are funneled through a single SendGrid client (`lib/resupply-email/src/client.ts`), ensuring a consistent `From` address (`info@pennpaps.com`) and centralized configuration. This includes order confirmations, shipping notifications, cart abandonment nudges, review moderation emails, and resupply reminders.

### Customer 360 (Admin)

A "Customers" section in the admin interface (`/admin/customers`) provides staff with a comprehensive view of each shop customer, including lifetime stats, orders, subscriptions, abandoned carts, and product reviews. Admins can reorder for customers directly from their profile.

## External Dependencies

*   **SendGrid:** For all outbound email communications.
*   **MediaPipe Face Mesh:** For on-device facial landmark detection.
*   **AWS:** Production deployment infrastructure.
*   **PostgreSQL:** Primary application database.
*   **Twilio:** For outbound voice calls and two-way SMS messaging in resupply.
*   **OpenAI:** Used by Resupply Automation for voice API and chat completions.
*   **Stripe:** For payment processing, cash-pay shop management, and product/price data.
*   **Google Cloud Storage (GCS):** For secure storage of prescription document attachments.