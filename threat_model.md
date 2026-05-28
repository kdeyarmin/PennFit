# Threat Model

## Project Overview

PennPaps is a privacy-first CPAP fitting, ordering, and resupply platform implemented as a pnpm monorepo. The production system consists primarily of two Node/Express backends (`artifacts/api-server` and `artifacts/resupply-api`), a background worker (`artifacts/resupply-worker`), and two React frontends (`artifacts/cpap-fitter` and `artifacts/resupply-dashboard`). PostgreSQL stores order data, reminder subscriptions, shop data, and resupply/patient records; Clerk provides authentication; Stripe handles checkout and subscription billing; SendGrid, Twilio, OpenAI, and Supabase Storage are integrated server-side.

Production scanning should focus on server-reachable code and production frontends. `artifacts/mockup-sandbox`, agent skill assets, generated review UIs, and other development-only helper content are out of scope unless a production path imports or serves them. The Railway edge proxy terminates TLS for deployed traffic, and `NODE_ENV=production` is assumed in production.

## Assets

- **Patient and customer data** — order forms, reminder subscriptions, shipping details, customer accounts, conversation history, and resupply records. Exposure can leak sensitive health-related or personal information.
- **Protected health information in resupply** — patient names, contact channels, prescription metadata, conversation content, and encrypted PHI columns in the resupply schema. Compromise has high privacy and regulatory impact.
- **User accounts and admin sessions** — Clerk-backed customer and admin identities, session state, role metadata, and allowlist-gated operator access. Compromise enables impersonation or privileged console access.
- **Billing state and order integrity** — Stripe checkout sessions, subscription state, order status, refund actions, and reorder flows. Tampering can cause fraudulent purchases, refunds, or account confusion.
- **Capability secrets and webhook secrets** — reminder manage tokens, Stripe/Twilio/SendGrid webhook verification material, Supabase Storage signed upload/download URLs, and environment secrets. Leakage can grant direct object access or let attackers drive privileged side effects.
- **Application secrets and service credentials** — database credentials, Clerk secret key, Stripe secret key, Twilio credentials, SendGrid API key, OpenAI credentials, and Supabase service-role JWT (used to mint Supabase Storage signed URLs). Exposure enables broad service compromise.

## Trust Boundaries

- **Browser to PennPaps API (`/api/*`)** — public fitting, reminders, recommendation, and order endpoints receive untrusted client input and must validate, rate-limit, and scope responses.
- **Browser to Resupply API (`/resupply-api/*`)** — public shop, customer-account, and vendor callback paths accept untrusted input; admin and PHI routes must enforce server-side authorization on every request.
- **Authenticated customer to unauthenticated public user** — customer-only shop/account operations must not be reachable with guessed identifiers or client-only checks.
- **Authenticated admin/agent to normal user** — admin dashboards, PHI views, uploads, reorder/refund tooling, and audit-affecting routes must enforce role checks server-side and prevent cross-surface privilege confusion between PennPaps admin and resupply admin.
- **API to PostgreSQL** — server code has broad database authority; injection or improper row scoping can expose or modify sensitive records.
- **API/worker to third-party services** — Stripe, Clerk, Twilio, SendGrid, OpenAI, and Supabase Storage calls cross into external systems using privileged credentials. Webhooks and callbacks must verify origin/authenticity.
- **HTTP to WebSocket upgrade (`/resupply-api/voice/stream`)** — upgrade requests bypass normal Express middleware and require their own authentication and anti-replay controls.
- **Development-only to production boundary** — mockup sandbox, internal skills, tests, generated eval pages, and dev fallbacks must not become production-reachable through misconfiguration or imports.

## Scan Anchors

- **Production entry points**: `artifacts/api-server/src/index.ts`, `artifacts/resupply-api/src/index.ts`, `artifacts/resupply-worker/src/index.ts`, frontend entries under `artifacts/cpap-fitter/src/main.tsx` and `artifacts/resupply-dashboard/src/main.tsx`.
- **Highest-risk code areas**: `artifacts/api-server/src/routes/*`, `artifacts/api-server/src/middlewares/requireAdmin.ts`, `artifacts/resupply-api/src/routes/{shop,admin,patients,voice,sms,email}/**`, `artifacts/resupply-api/src/lib/stripe/**`, `artifacts/resupply-api/src/middlewares/{requireAdmin,requireSignedIn,idempotency,rate-limit}.ts`, `lib/resupply-db/**`, `lib/resupply-email/**`, `lib/resupply-telecom/**`.
- **Public surfaces**: `/api/recommend`, `/api/orders`, `/api/reminders*`, `/resupply-api/shop/*`, `/resupply-api/stripe/webhook`, `/resupply-api/voice/*`, `/resupply-api/sms/*`, `/resupply-api/email/*`.
- **Authenticated/admin surfaces**: `/api/admin/*`, `/resupply-api/me`, `/resupply-api/shop/me/*`, `/resupply-api/dashboard/*`, `/resupply-api/patients/*`, `/resupply-api/rules/*`, `/resupply-api/conversations/*`, `/resupply-api/episodes/*`, `/resupply-api/audit/*`, `/resupply-api/admin/shop/*`.
- **Usually dev-only / ignore unless proven reachable**: `artifacts/mockup-sandbox/**`, `.agents/**`, `.local/**`, tests, generated review/eval assets, build output under `dist/**`.

## Threat Categories

### Spoofing

The platform relies on Clerk for both customer and admin identity, while several vendor-facing endpoints rely on signatures or capability-style tokens instead of interactive login. The system must authenticate every protected request server-side, distinguish PennPaps admin authority from resupply admin authority, require verified identities where allowlists are used, and reject forged Stripe, Twilio, and SendGrid callbacks. Capability links such as reminder manage tokens and signed storage URLs must be unguessable and narrowly scoped.

### Tampering

Public clients submit questionnaire data, order details, reminder state, cart contents, and checkout parameters. Admins and background jobs can mutate patient, order, tracking, review, inventory, and rule records. The system must treat all client input as untrusted, compute security-relevant decisions server-side, prevent client-controlled redirect targets or price manipulation, and ensure idempotency or replay controls exist where repeated requests could duplicate billing, emails, or state transitions.

### Information Disclosure

The application stores PHI-adjacent and customer data and intentionally treats logs as world-readable. The system must avoid logging request bodies, tokens, raw third-party errors, or unnecessary PII; must scope database reads to the authenticated actor or authorized admin role; and must ensure object retrieval endpoints, signed URLs, reminder manage flows, customer account APIs, and admin dashboards only disclose the minimum required data.

### Denial of Service

Public endpoints include order submission, reminder subscription management, shop checkout creation, vendor webhooks, and voice-related paths. The system must apply rate limits or bounded work to expensive anonymous endpoints, cap request body sizes and upload sizes, fail closed when critical config is missing, and avoid unbounded retries or long-lived upgrade abuse that can exhaust service capacity or external provider limits.

### Elevation of Privilege

The highest-impact failures would let a normal user reach admin/agent capabilities, let one customer access another customer's orders or saved data, or let external callers mutate PHI or billing state without proper authorization. The system must enforce role checks on every admin route, prevent IDOR across customer and patient resources, keep dev fallbacks out of production, use parameterized database access, validate filesystem/object-storage identifiers, and ensure websocket or webhook side channels do not bypass the main authorization model.
