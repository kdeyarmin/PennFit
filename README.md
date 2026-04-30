# PennFit / PennPaps

Privacy-first CPAP fitting, ordering, and resupply automation for
Penn Home Medical Supply. See [`replit.md`](./replit.md) for the
full product and architecture overview.

This is a `pnpm` workspaces monorepo (Node v24, TypeScript 5.9). The
top-level structure is:

| Path | What lives here |
| --- | --- |
| `artifacts/api-server` | Penn-Fit storefront / fitter API (Express). |
| `artifacts/resupply-api` | Resupply automation API + voice WS endpoint (Express). |
| `artifacts/resupply-worker` | `pg-boss` background worker for reminders and PHI sweeps. |
| `artifacts/cpap-fitter` | Customer-facing fitter SPA (Vite + React). |
| `artifacts/resupply-dashboard` | Internal admin console SPA (Vite + React). |
| `artifacts/mockup-sandbox` | Internal UI/UX mockup playground (Vite + React). |
| `artifacts/penn-fit-tutorial` | Animated onboarding tutorial app (Vite + React). |
| `lib/*` | Shared workspace packages (DB, contracts, messaging, etc.). |

## Prerequisites

- Node.js **v24**
- pnpm **v9+**
- Postgres (with the `pgcrypto` extension installed; the resupply
  services refuse to start without it)

## Getting started

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Copy the env template and fill in the values you need
cp .env.example .env

# 3. Type-check the whole workspace
pnpm typecheck

# 4. Build everything (libraries and apps)
pnpm build

# 5. Run a specific app (examples)
pnpm --filter @workspace/api-server dev
pnpm --filter @workspace/resupply-api dev
pnpm --filter @workspace/resupply-worker dev
```

Each long-running service validates its required environment
variables at startup and fails fast with a single error listing
**every** missing variable, so you can fix a fresh deploy in one
pass instead of restart-by-restart. Variables that gracefully
degrade (Twilio, SendGrid, OpenAI, Stripe, object storage, etc.)
are intentionally NOT required at boot — the services run in a
partially-configured mode so dev / preview environments don't need
every third-party credential.

## Environment variables

The full template lives in [`.env.example`](./.env.example). The
table below shows which variables each service **requires** to
boot, and which it consumes when configured. `.env` is git-ignored —
never commit real secrets.

### Required at boot (services refuse to start if missing)

| Variable | `api-server` | `resupply-api` | `resupply-worker` | Notes |
| --- | :---: | :---: | :---: | --- |
| `PORT` | ✅ | ✅ | — | HTTP listen port. |
| `CLERK_SECRET_KEY` | ✅ | ✅ | — | Clerk backend auth. |
| `DATABASE_URL` | — | ✅ | ✅ | Postgres connection string. `pgcrypto` must be enabled. |
| `RESUPPLY_DATA_KEY` | — | ✅ | ✅ | 32+ byte secret. PHI bulk-encryption key (`pgp_sym_*`). |
| `RESUPPLY_LINK_HMAC_KEY` | — | ✅ | ✅ | 32+ byte secret. Signs reminder/email deep-links. |
| `RESUPPLY_PHONE_HMAC_KEY` | — | ✅ | ✅ | 32+ byte secret. Phone-number lookup HMAC (separate from the bulk key on purpose — see `lib/resupply-db/src/phone-hash.ts`). |

> Generate any of the secret keys with `openssl rand -base64 48`.

### Optional / feature-gated (degrade gracefully when unset)

| Variable | Used by | Effect when missing |
| --- | --- | --- |
| `NODE_ENV`, `LOG_LEVEL` | All services | Defaults to `development` / `info`. |
| `BASE_PATH` | Vite apps | Required by every Vite app at config time (the config throws if missing or empty). Set to `/` for root mounts. |
| `PENN_ALLOWED_ORIGINS` | `api-server` | CORS allowlist. Falls back to Replit dev domain + localhost. |
| `RESUPPLY_ALLOWED_ORIGINS` | `resupply-api` | CORS allowlist. Falls back to Replit dev domain + localhost. |
| `SHOP_PUBLIC_BASE_URL`, `REMINDER_PUBLIC_BASE_URL`, `RESUPPLY_VOICE_PUBLIC_BASE_URL` | `resupply-api` | Public base URLs used in outbound deep links. Cart-recovery + reminder emails fall through `SHOP → RESUPPLY_VOICE → https://pennpaps.com` in order. |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | `api-server`, `resupply-api`, `resupply-worker` | Outbound email + delivery webhooks. Email features log-and-skip when missing. |
| `PENN_FROM_EMAIL`, `PENN_FULFILLMENT_EMAIL` | `api-server` | Storefront notification senders. |
| `RESUPPLY_ADMIN_EMAILS`, `RESUPPLY_AGENT_EMAILS`, `RESUPPLY_OPERATOR_EMAILS` | `resupply-api` | Comma-separated allowlists for role-gated admin endpoints. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID` | `resupply-api` | SMS + voice. Outbound SMS / voice routes return 503 when missing. |
| `OPENAI_API_KEY` | `resupply-api` | Conversation AI. AI features disable when missing. |
| `STRIPE_SECRET_KEY` | `resupply-api` | Cash-pay shop checkout + webhooks. Shop endpoints return preview-mode responses when missing. |
| `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` | `resupply-api`, `resupply-worker` | Replit Object Storage paths for prescription attachments. |
| `VITE_CLERK_PUBLISHABLE_KEY` | Vite apps | Browser-side Clerk publishable key. |
| `VITE_ENABLE_DEMO`, `VITE_RESUPPLY_CONTACT_EMAIL` | Vite apps | UI feature flags / display values. |
| `CODEGEN_OUT_PENN_FIT_CLIENT`, `CODEGEN_OUT_PENN_FIT_ZOD`, `CODEGEN_OUT_RESUPPLY_CLIENT` | `scripts/codegen` | Override OpenAPI codegen output paths. Defaults are in-repo. |
| `REPL_ID`, `REPLIT_DEV_DOMAIN`, `REPLIT_DOMAINS` | All services | Set automatically on Replit; usually leave blank locally. |

## Useful scripts

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --build` across libs + per-app `typecheck`. |
| `pnpm build` | Type-check, then `build` in every package that defines one. |
| `pnpm lint:resupply` | ESLint (zero warnings) over the resupply surface. |
| `pnpm --filter <pkg> test` | Vitest for a specific package (resupply-api, resupply-worker, …). |

## Privacy contract

Two non-negotiable rules from `replit.md` worth repeating here:

- **Do not add image logging anywhere in the backend.** Camera images
  and video frames never leave the browser; only numeric facial
  measurements are transmitted.
- **Do not log order request bodies in the application logger.** Treat
  every log line as world-readable.
