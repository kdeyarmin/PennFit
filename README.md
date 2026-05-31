# PennPaps

Privacy-first CPAP fitting, ordering, and resupply automation for
Penn Home Medical Supply. See [`CLAUDE.md`](./CLAUDE.md) for guidance
aimed at coding agents (Claude Code and similar).

## Hosting

The app is designed to run on **Railway**. The repo ships with
`railway.json` at the root, so connecting the GitHub repo to a Railway
project and pointing it at the `main` branch is enough to build +
deploy. Railpack auto-detects pnpm + Node from the root `package.json`
(`packageManager` and `engines.node`); no `nixpacks.toml` or
`Dockerfile` is required. Custom domain → Railway → DNS; the fallback
host is `pennfit.up.railway.app`. Environment variables are configured
under **Variables** in the Railway service settings; the required set is
documented below and validated by `preflight:prod`.

## Git source of truth

**Canonical ref:** `main` on `https://github.com/kdeyarmin/PennFit`
(remote-tracking name: `origin/main`).

**At the start of every session, every agent and human MUST:**

```bash
# 1. Confirm clean tree
git status

# 2. Pull canonical ref and align local main to it
git fetch origin
git rev-list --count main..origin/main   # how many commits you're behind
# If clean and behind: align (destructive — only when status is clean)
git reset --hard origin/main
```

**Where new work lands:** push a feature branch and open a PR on
`github.com/kdeyarmin/PennFit`. Do NOT commit directly to local
`main` and let it drift again.

**Pre-commit drift block:** the pre-commit hook blocks commits to
local `main` when it is behind `origin/main`. Bypass with
`SKIP_HOOKS=1 git commit ...` or `--no-verify` for genuine
emergencies.

This is a `pnpm` workspaces monorepo (Node v24, TypeScript 5.9). The
top-level structure is:

| Path                     | What lives here                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/resupply-api` | Single Express API process — resupply automation + voice WS endpoint AND the storefront/fitter routes (Task #37 merged the former `artifacts/api-server` in here, mounted at both `/resupply-api/*` and `/api/*`). As of the May 2026 round-3 consolidation it ALSO hosts the in-process `pg-boss` worker (reminder scans + PHI attachment sweeps) — see `src/worker/index.ts`. The former separate `artifacts/resupply-worker` artifact is gone. |
| `artifacts/cpap-fitter`  | Customer-facing fitter SPA (Vite + React). Also mounts the internal admin console at `/admin/*` (gated by `useGetAdminMe`) — the former separate `artifacts/resupply-dashboard` SPA was folded in here so the project ships ONE customer-facing site. Legacy `/resupply/*` deep links SPA-redirect to `/admin/*` with query strings preserved.                                                                                                    |
| `artifacts/shared`       | Shared cross-artifact assets (currently the favicon set served at the root path).                                                                                                                                                                                                                                                                                                                                                                 |
| `lib/*`                  | Shared workspace packages (DB, auth, messaging, email, AI, telecom, audit, domain, secrets, reminders, plus the API client + auth React adapters).                                                                                                                                                                                                                                                                                                |

## Prerequisites

- Node.js **v24** (matches CI; `engines.node` is pinned to `>=24`).
  The repo ships `.nvmrc` and `.node-version` (both `24`), so
  `nvm use` / `fnm use` / `asdf` auto-select the right major on
  clone — run it before `pnpm install` to avoid an
  `ERR_PNPM_UNSUPPORTED_ENGINE` mismatch.
- pnpm **v11+** (pinned to `pnpm@11.5.0` via `packageManager`).
  With Corepack enabled (`corepack enable`), the pinned pnpm is
  selected automatically from the repo root.
- Postgres **v14+** (we run v16). No extensions required — the
  active resupply schema only relies on `gen_random_uuid()`, which
  has been built into Postgres core since v13.

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
pnpm --filter @workspace/resupply-api dev   # boots the in-process pg-boss worker too
pnpm --filter @workspace/cpap-fitter dev    # serves customer storefront + admin console
```

Locally, set `PORT` and `BASE_PATH` per-artifact before running
`pnpm --filter @workspace/<artifact> dev`. The cpap-fitter SPA
expects `BASE_PATH=/` and a free port (typically 5173); the
resupply-api expects a port distinct from the SPA (typically 3000).
On Railway, `PORT` is injected by the platform and `BASE_PATH`
defaults to `/`.

Each long-running service validates its required environment
variables at startup and fails fast with a single error listing
**every** missing variable, so you can fix a fresh deploy in one
pass instead of restart-by-restart. Variables that gracefully
degrade (Twilio, SendGrid, OpenAI, Stripe, object storage, etc.)
are intentionally NOT required at boot — the services run in a
partially-configured mode so dev / preview environments don't need
every third-party credential.

### Deploying to production

Run [`pnpm --filter @workspace/scripts preflight:prod`](./scripts/src/preflight-prod-env.ts)
against the loaded env to catch shape-level mistakes (test keys in
prod, localhost URLs, identical HMAC keys, `STRIPE_WEBHOOK_SECRET`
name confusion, `.env.example` placeholders still in place, etc.)
**before** the API tries to boot. The script exits non-zero on any
FAIL so it can gate the deploy.

The full five-step first-launch procedure (generate HMAC keys → set
production secrets → run preflight → migrate the prod DB → bootstrap
the first admin → smoke-test) lives in
[`docs/runbooks/production-launch.md`](./docs/runbooks/production-launch.md).
The broader operator checklist (TLS, CORS, logging, dependency
hygiene, backups) is in
[`docs/PRODUCTION_READINESS.md`](./docs/PRODUCTION_READINESS.md).

## Environment variables

The full template lives in [`.env.example`](./.env.example), organised
into **secrets** (credentials, signing/encryption keys) and
**configuration** (ports, URLs, addresses, allow-lists, paths). The
table below shows which variables each service **requires** to boot,
and which it consumes when configured. `.env` is git-ignored — never
commit real secrets.

### Required at boot (services refuse to start if missing)

After the May 2026 consolidations there is now exactly one backend
service to configure: `resupply-api`. Task #37 folded the legacy
`api-server` into it (so `PENN_FULFILLMENT_EMAIL`,
etc. are now read by `resupply-api`). The round-3 consolidation then
folded the former `resupply-worker` process in too (pg-boss boots
in-process at startup), so the env table no longer needs a separate
worker column.

The Task #38 follow-up removed `AUTH_PASSWORD_PEPPER`. Passwords are
hashed with plain argon2id; if you still have an `AUTH_PASSWORD_PEPPER`
secret in your environment from an earlier deploy, it is silently
ignored — feel free to delete it.

| Variable                                                  | `resupply-api` | Notes                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | :------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                    |       ✅       | HTTP listen port.                                                                                                                                                                                                                                                                                                        |
| `DATABASE_URL`                                            |       ✅       | Postgres connection string (v14+). No extensions required. The same connection string is also used by the in-process pg-boss worker (it owns its own pool, distinct from the application pool).                                                                                                                          |
| `SUPABASE_URL`                                            |       ✅       | Production Supabase project URL (from Studio → Project Settings → API). The resupply-api routes its reads/writes through the Supabase JS service-role client — this is the only runtime data path. URL is safe to expose; the key is not.                                                                                |
| `SUPABASE_SERVICE_ROLE_KEY`                               |       ✅       | Service-role JWT for the project above. Bypasses RLS; MUST stay server-side. Both this and `SUPABASE_URL` are validated by `validateSupabaseEnv()` in `lib/resupply-db/src/supabase-client.ts`.                                                                                                                          |
| `RESUPPLY_LINK_HMAC_KEY`                                  |       ✅       | 32+ random bytes used to sign the short-lived patient links delivered in SMS / email reminders. Generate with `openssl rand -base64 48`. Rotating it invalidates in-flight links.                                                                                                                                        |
| `RESUPPLY_ALLOWED_ORIGINS` **or** `RAILWAY_PUBLIC_DOMAIN` |       ✅       | CORS allowlist hostnames (at least one required). In production `artifacts/resupply-api/src/app.ts` throws at boot if both are empty. On Railway, `RAILWAY_PUBLIC_DOMAIN` is auto-populated; set `RESUPPLY_ALLOWED_ORIGINS` explicitly when you need multiple origins (custom domain + the `*.up.railway.app` fallback). |
| `SUPABASE_STORAGE_BUCKET_PRIVATE`                         |       ✅       | Bucket name in Supabase Storage where customer attachments land (POD photos, prescription PDFs, MMS media). The PHI attachment sweep job refuses to register without it.                                                                                                                                                 |

> Migration 0025 stripped pgcrypto column-level PHI encryption and
> dropped the `phone_lookup` table, so the legacy
> `RESUPPLY_MASTER_KEY` / `RESUPPLY_DATA_KEY` / `RESUPPLY_PHONE_HMAC_KEY`
> secrets are no longer read by any code path. Delete them from your
> secrets store if they're still hanging around.

### Optional / feature-gated (degrade gracefully when unset)

| Variable                                                                                                                                                                                               | Used by               | Effect when missing                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`, `LOG_LEVEL`                                                                                                                                                                                | All services          | Defaults to `development` / `info`.                                                                                                                                                                                                                                                                                                                                                        |
| `BASE_PATH`                                                                                                                                                                                            | Vite apps             | Required by every Vite app at config time (the config throws if missing or empty). Set to `/` for root mounts.                                                                                                                                                                                                                                                                             |
| `RESUPPLY_ALLOWED_ORIGINS`                                                                                                                                                                             | `resupply-api`        | CORS allowlist for the `/resupply-api/*` mount. In `NODE_ENV=production` the API throws at boot if BOTH this and `RAILWAY_PUBLIC_DOMAIN` are empty (`artifacts/resupply-api/src/app.ts`); on Railway, `RAILWAY_PUBLIC_DOMAIN` is auto-populated so this is genuinely optional there. Outside production, falls back to localhost ports.                                                    |
| `SHOP_PUBLIC_BASE_URL`, `REMINDER_PUBLIC_BASE_URL`, `RESUPPLY_VOICE_PUBLIC_BASE_URL`                                                                                                                   | `resupply-api`        | Public base URLs used in outbound deep links. Cart-recovery + reminder emails fall through `SHOP → RESUPPLY_VOICE → https://pennpaps.com` in order.                                                                                                                                                                                                                                        |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`                                                                                                   | `resupply-api`        | Outbound email + delivery webhooks (used by both the request-handling routes and the in-process worker's reminder jobs). Every sender across the monorepo funnels through the shared `createSendgridClient()` in `lib/resupply-email`, so `SENDGRID_FROM_EMAIL` (set to `info@pennpaps.com`) is the single From address for the entire platform. Email features log-and-skip when missing. |
| `PENN_FULFILLMENT_EMAIL`                                                                                                                                                                               | `resupply-api`        | Where Penn Fit fulfillment receives new mask orders (this is the recipient, not the sender).                                                                                                                                                                                                                                                                                               |
| `RESUPPLY_ADMIN_EMAILS`, `RESUPPLY_AGENT_EMAILS`, `RESUPPLY_OPERATOR_EMAILS`                                                                                                                           | `resupply-api`        | Display-only allowlist counts shown on `/admin/operations`. Role-gating itself is DB-driven now (`requireAdmin` reads `auth.users.role`); these env vars are not consulted by the auth middleware. Safe to leave empty; bootstrap the first admin via `pnpm --filter @workspace/scripts auth:bootstrap-admin`.                                                                             |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`                                                                                                       | `resupply-api`        | SMS + voice. Outbound SMS / voice routes return 503 when missing.                                                                                                                                                                                                                                                                                                                          |
| `OPENAI_API_KEY`                                                                                                                                                                                       | `resupply-api`        | Conversation AI. AI features disable when missing.                                                                                                                                                                                                                                                                                                                                         |
| `STRIPE_SECRET_KEY`                                                                                                                                                                                    | `resupply-api`        | Cash-pay shop checkout + webhooks. Shop endpoints return preview-mode responses when missing.                                                                                                                                                                                                                                                                                              |
| `SUPABASE_STORAGE_BUCKET_PRIVATE`, `SUPABASE_STORAGE_BUCKET_PUBLIC`                                                                                                                                    | `resupply-api`        | Supabase Storage bucket names for prescription attachments + public assets. The private bucket is required at boot — the upload routes and the worker's PHI sweep both refuse to start without it. Per-object ACL lives in `resupply.object_storage_acls` (migration 0165), not in bucket-level RLS.                                                                                       |
| `VITE_RESUPPLY_CONTACT_EMAIL`                                                                                                                                                                          | Vite apps             | UI display value (contact email surfaced in the SPA).                                                                                                                                                                                                                                                                                                                                      |
| `AIRVIEW_*`, `CARE_ORCHESTRATOR_*`, `REACT_HEALTH_*` (client id/secret + base/token URLs + account/partner/DME ids)                                                                                    | `resupply-api`        | Therapy-cloud pull adapters (ResMed AirView / Philips Care Orchestrator / 3B React Health) in `lib/resupply-integrations-*`. Feature-gated + fail-soft: the nightly `therapy-integrations.nightly-sync` skips any vendor whose `availability()` is unavailable, and the admin Integrations page shows a badge.                                                                             |
| `PARACHUTE_CLIENT_ID`, `PARACHUTE_CLIENT_SECRET`, `PARACHUTE_SIGNING_SECRET`, `PARACHUTE_API_BASE_URL`, `PARACHUTE_STUB`                                                                               | `resupply-api`        | Parachute Health inbound DME-order webhook (HMAC-verified). Inbound referral intake stays idle when unset; `PARACHUTE_STUB=1` accepts fixtures without live creds.                                                                                                                                                                                                                         |
| `APPLE_WALLET_SIGNER_CERT_PEM`, `APPLE_WALLET_SIGNER_KEY_PEM`, `APPLE_WALLET_WWDR_CERT_PEM`, `APPLE_WALLET_PASS_TYPE_ID`, `APPLE_WALLET_TEAM_ID`                                                       | `resupply-api`        | Apple Wallet order-pass signing. Wallet passes are disabled when unset.                                                                                                                                                                                                                                                                                                                    |
| `OFFICE_ALLY_*` (SFTP + ETIN + billing identity)                                                                                                                                                       | `resupply-api`        | Office Ally clearinghouse for real-time eligibility (270/271) + claims (837P) + the inbound 999/277CA/835 poll. Runs in stub/outbox mode until configured. PREFERRED: set identity + connection in the admin UI (**Billing → Config**), which the identity-resolver uses over these env vars. Partial env config FAILs `preflight:prod`. See `docs/runbooks/office-ally-go-live.md`.       |
| `STRIPE_PUBLISHABLE_KEY`                                                                                                                                                                               | Vite apps             | Browser-exposed Stripe publishable key for checkout.                                                                                                                                                                                                                                                                                                                                       |
| `SENDGRID_INBOUND_PARSE_BASIC_AUTH`                                                                                                                                                                    | `resupply-api`        | Basic-auth (`user:pass`) guard on the SendGrid Inbound Parse webhook (`/email/inbound-parse`).                                                                                                                                                                                                                                                                                             |
| `INSURANCE_LEAD_NOTIFICATION_EMAIL`, `RESUPPLY_SUPPLIER_FAX_E164`, `RESUPPLY_SUPPLIER_RETURN_EMAIL`, `TWILIO_VOICE_PHONE_NUMBER`, `CARRIER_LABEL_VENDOR`, `DB_POOL_MAX`, `AUTH_REQUIRE_MFA_FOR_ADMINS` | `resupply-api`        | Misc tuning: insurance-lead recipient; supplier fax / return contacts printed on Rx + return docs; voice caller-id; shipping-label vendor; pg pool size; admin-MFA enforcement. Each has a sensible default or the feature skips when unset.                                                                                                                                               |
| `RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED`, `RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED`, `RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED`, `FITTER_SUPPLY_CAMPAIGN_PROMO`, `FITTER_FINAL_CALL_PROMO`            | `resupply-api` worker | Env-gated pg-boss dispatchers (`1` to enable) + optional promo codes surfaced in the fitter supply-campaign emails. Most other toggles now live in the DB `feature_flags` table (admin Control Center).                                                                                                                                                                                    |
| `RAILWAY_PUBLIC_DOMAIN`                                                                                                                                                                                | All services          | Set automatically on Railway to the canonical `*.up.railway.app` host (or the bound custom domain). The API reads it as a CORS-allowlist fallback and as a source for the public base URL Twilio/Stripe callbacks use when `RESUPPLY_VOICE_PUBLIC_BASE_URL` is unset. Leave blank locally.                                                                                                 |

## Useful scripts

| Command                                                 | What it does                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                        | `tsc --build` across libs + per-app `typecheck`.                                                                                                                                                                                                               |
| `pnpm build`                                            | Type-check, then `build` in every package that defines one.                                                                                                                                                                                                    |
| `pnpm lint:resupply`                                    | ESLint (zero warnings) over the resupply surface.                                                                                                                                                                                                              |
| `pnpm --filter <pkg> test`                              | Vitest for a specific package (resupply-api, the resupply-\* libs, …).                                                                                                                                                                                         |
| `pnpm --filter @workspace/scripts preflight:prod`       | Read-only validator that audits `process.env` against production constraints (sk_live vs sk_test, HTTPS-only public URLs, HMAC-key shape, etc.). Exits non-zero on any FAIL. See [`docs/runbooks/production-launch.md`](./docs/runbooks/production-launch.md). |
| `pnpm --filter @workspace/scripts auth:bootstrap-admin` | Insert the first admin row into `resupply_auth.users` and issue a 1-hour password-reset link (emailed when SendGrid is configured, printed to stdout otherwise). Used once per environment to break the chicken-and-egg on a fresh DB.                         |

## Privacy contract

Two non-negotiable rules from `CLAUDE.md` worth repeating here:

- **Do not add image logging anywhere in the backend.** Camera images
  and video frames never leave the browser; only numeric facial
  measurements are transmitted.
- **Do not log order request bodies in the application logger.** Treat
  every log line as world-readable.
