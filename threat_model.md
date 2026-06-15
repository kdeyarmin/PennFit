# Threat Model

## Project Overview

PennPaps is a privacy-first CPAP fitting, ordering, and resupply platform implemented as a pnpm monorepo. The production system has one Express API process (`artifacts/resupply-api`) and one React/Vite SPA (`artifacts/cpap-fitter`). The API hosts the storefront/fitter routes under `/api/*`, the resupply/admin/voice routes under `/resupply-api/*`, and the in-process pg-boss worker from `artifacts/resupply-api/src/worker`. The SPA hosts both the customer-facing fitter/storefront and the internal admin console under `/admin/*`. PostgreSQL/Supabase stores order data, reminder subscriptions, shop data, and resupply/patient records; in-house cookie auth provides customer, admin, and provider sessions; Stripe handles checkout and subscription billing; SendGrid, Twilio/Telnyx, OpenAI/Anthropic, and Supabase Storage are integrated server-side.

Production scanning should focus on server-reachable code and production frontends. `artifacts/mockup-sandbox`, agent skill assets, generated review UIs, and other development-only helper content are out of scope unless a production path imports or serves them. The Railway edge proxy terminates TLS for deployed traffic, and `NODE_ENV=production` is assumed in production.

## Assets

- **Patient and customer data** - order forms, reminder subscriptions, shipping details, customer accounts, conversation history, and resupply records. Exposure can leak sensitive health-related or personal information.
- **Protected health information in resupply** - patient names, contact channels, prescription metadata, conversation content, and plaintext PHI columns in the resupply schema. Compromise has high privacy and regulatory impact.
- **User accounts and sessions** - in-house customer, admin, and provider identities; DB-backed session state; role metadata; MFA state; and allowlist-gated operator access. Compromise enables impersonation or privileged console access.
- **Billing state and order integrity** - Stripe checkout sessions, subscription state, order status, refund actions, insurance worklists, and reorder flows. Tampering can cause fraudulent purchases, refunds, shipment errors, or account confusion.
- **Capability secrets and webhook secrets** - reminder/manage tokens, signed patient/order/provider links, Stripe/Twilio/SendGrid/Telnyx/vendor webhook verification material, Supabase Storage signed upload/download URLs, and environment secrets. Leakage can grant direct object access or let attackers drive privileged side effects.
- **Application secrets and service credentials** - database credentials, Stripe secret key, telecom credentials, SendGrid API key, AI provider credentials, integration credentials, and the Supabase service-role JWT. Exposure enables broad service compromise.

## Trust Boundaries

- **Browser to public API (`/api/*` and public `/resupply-api/*`)** - fitting, reminders, recommendation, order, shop, auth, provider-link, and token/capability endpoints receive untrusted client input and must validate, rate-limit, and scope responses.
- **Authenticated customer/provider/admin to privileged API** - customer account, provider portal, and admin operations must enforce server-side authorization on every request and avoid cross-surface privilege confusion.
- **Authenticated customer to unauthenticated public user** - customer-only shop/account operations must not be reachable with guessed identifiers or client-only checks.
- **Authenticated admin/agent to normal user** - admin dashboards, PHI views, uploads, reorder/refund tooling, billing, integrations, and automation routes must enforce role checks server-side.
- **API/worker to PostgreSQL via Supabase service-role client** - server code has broad database authority; injection or improper row scoping can expose or modify sensitive records.
- **API/worker to third-party services** - Stripe, telecom/email providers, AI providers, payer/claims systems, therapy-cloud partners, and Supabase Storage calls cross into external systems using privileged credentials. Webhooks and callbacks must verify origin/authenticity.
- **HTTP to WebSocket upgrade (`/resupply-api/voice/stream`)** - upgrade requests bypass normal Express middleware and require their own authentication and anti-replay controls.
- **Development-only to production boundary** - mockup sandbox, internal skills, tests, generated eval pages, and dev fallbacks must not become production-reachable through misconfiguration or imports.

## Scan Anchors

- **Production entry points**: `artifacts/resupply-api/src/index.ts`, `artifacts/resupply-api/src/app.ts`, `artifacts/resupply-api/src/worker/index.ts`, and `artifacts/cpap-fitter/src/main.tsx`.
- **Highest-risk code areas**: `artifacts/resupply-api/src/routes/{shop,admin,patients,provider,voice,sms,email,integrations-webhooks}.ts`, `artifacts/resupply-api/src/lib/{stripe,billing,voice,object-storage}/**`, `artifacts/resupply-api/src/middlewares/{requireAdmin,requireSignedIn,csrf,idempotency,rate-limit}.ts`, `lib/resupply-db/**`, `lib/resupply-auth/**`, `lib/resupply-email/**`, `lib/resupply-telecom/**`, and `lib/resupply-integrations*/**`.
- **Public surfaces**: `/api/recommend`, `/api/orders`, `/api/reminders*`, `/api/auth/*`, `/api/shop/*`, `/resupply-api/shop/*`, `/resupply-api/stripe/webhook`, `/resupply-api/voice/*`, `/resupply-api/sms/*`, `/resupply-api/email/*`, `/resupply-api/integrations/webhooks/*`, and token-gated patient/provider signing routes.
- **Authenticated/admin surfaces**: `/api/admin/*`, `/resupply-api/me`, `/resupply-api/shop/me/*`, `/resupply-api/patients/*`, `/resupply-api/rules/*`, `/resupply-api/conversations/*`, `/resupply-api/episodes/*`, `/resupply-api/admin/*`, `/resupply-api/provider/*`, billing/claims routes, and system configuration routes.
- **Usually dev-only / ignore unless proven reachable**: `artifacts/mockup-sandbox/**`, `.agents/**`, `.local/**`, tests, generated review/eval assets, build output under `dist/**`.

## Threat Categories

### Spoofing

The platform relies on in-house cookie sessions for customer, admin, and provider identity, while several vendor-facing endpoints rely on signatures or capability-style tokens instead of interactive login. The system must authenticate every protected request server-side, distinguish customer/provider/admin authority, require verified identities where allowlists are used, and reject forged Stripe, Twilio/Telnyx, SendGrid, and integration callbacks. Capability links such as reminder manage tokens, patient packet links, provider signing links, order-pay links, and signed storage URLs must be unguessable and narrowly scoped.

### Tampering

Public clients submit questionnaire data, order details, reminder state, cart contents, and checkout parameters. Admins and background jobs can mutate patient, order, tracking, review, inventory, billing, and rule records. The system must treat all client input as untrusted, compute security-relevant decisions server-side, prevent client-controlled redirect targets or price manipulation, and ensure idempotency or replay controls exist where repeated requests could duplicate billing, emails, or state transitions.

### Information Disclosure

The application stores PHI-adjacent and customer data and intentionally treats logs as world-readable. The system must avoid logging request bodies, tokens, raw third-party errors, or unnecessary PII; must scope database reads to the authenticated actor or authorized admin role; and must ensure object retrieval endpoints, signed URLs, reminder manage flows, customer account APIs, provider APIs, and admin dashboards only disclose the minimum required data.

### Denial of Service

Public endpoints include order submission, reminder subscription management, shop checkout creation, vendor webhooks, and voice-related paths. The system must apply rate limits or bounded work to expensive anonymous endpoints, cap request body sizes and upload sizes, fail closed when critical config is missing, cache or bound dependency probes, and avoid unbounded retries or long-lived upgrade abuse that can exhaust service capacity or external provider limits.

### Elevation of Privilege

The highest-impact failures would let a normal user reach admin/agent capabilities, let one customer or provider access another actor's data, or let external callers mutate PHI or billing state without proper authorization. The system must enforce role checks on every admin route, prevent IDOR across customer, provider, and patient resources, keep dev fallbacks out of production, use parameterized database access, validate filesystem/object-storage identifiers, and ensure websocket or webhook side channels do not bypass the main authorization model.
