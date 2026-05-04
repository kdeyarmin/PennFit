# PennPaps

Privacy-first CPAP fitting, ordering, and resupply automation for
Penn Home Medical Supply. See [`replit.md`](./replit.md) for the
full product and architecture overview, and [`CLAUDE.md`](./CLAUDE.md)
for guidance aimed at coding agents (Claude Code and similar).

## Git source of truth

**Canonical ref:** `main` on `https://github.com/kdeyarmin/PennFit`
(the Replit remote-tracking name is `subrepl-3ppc2e03/main`).

**Why this exists:** in May 2026 the Replit workspace, GitHub, and
Replit's `gitsafe-backup` snapshots had drifted by ~150 commits
across four divergent lines because no agent or human knew which
surface was authoritative. See
[`docs/git-state-2026-05-01.md`](./docs/git-state-2026-05-01.md) for
the post-mortem. This rule prevents a repeat.

**At the start of every session, every agent and human MUST:**

```bash
# 1. Confirm clean tree
git status

# 2. Pull canonical ref and align local main to it
git fetch subrepl-3ppc2e03
git rev-list --count main..subrepl-3ppc2e03/main   # how many commits you're behind
# If clean and behind: align (destructive — only when status is clean)
git reset --hard subrepl-3ppc2e03/main
```

**Where new work lands:** push a feature branch and open a PR on
`github.com/kdeyarmin/PennFit`. Do NOT commit directly to local
`main` and let it drift again. The Replit Git pane has a "Push"
action that creates the branch on the remote; finish the PR on
github.com.

**Pre-commit drift warning:** the pre-commit hook prints a non-
blocking warning when local `main` is more than 10 commits behind
`subrepl-3ppc2e03/main`. Bypass with `SKIP_HOOKS=1 git commit ...`
or `--no-verify` for genuine emergencies.

This is a `pnpm` workspaces monorepo (Node v24, TypeScript 5.9). The
top-level structure is:

| Path                     | What lives here                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/resupply-api` | Single Express API process — resupply automation + voice WS endpoint AND the storefront/fitter routes (Task #37 merged the former `artifacts/api-server` in here, mounted at both `/resupply-api/*` and `/api/*`). As of the May 2026 round-3 consolidation it ALSO hosts the in-process `pg-boss` worker (reminder scans + PHI attachment sweeps) — see `src/worker/index.ts`. The former separate `artifacts/resupply-worker` artifact is gone. |
| `artifacts/cpap-fitter`  | Customer-facing fitter SPA (Vite + React). Also mounts the internal admin console at `/admin/*` (gated by `useGetAdminMe`) — the former separate `artifacts/resupply-dashboard` SPA was folded in here so the project ships ONE customer-facing site. Legacy `/resupply/*` deep links SPA-redirect to `/admin/*` with query strings preserved.                                                                                                    |
| `artifacts/shared`       | Shared cross-artifact assets (currently the favicon set served at the root path).                                                                                                                                                                                                                                                                                                                                                                 |
| `lib/*`                  | Shared workspace packages (DB, auth, messaging, email, AI, telecom, audit, domain, secrets, reminders, plus the API client + auth React adapters).                                                                                                                                                                                                                                                                                                |

## Prerequisites

- Node.js **v24**
- pnpm **v9+**
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

In the Replit workspace, prefer the registered workflows
(`artifacts/resupply-api: Resupply API` and `artifacts/cpap-fitter:
web`) over running `pnpm dev` directly — the workflows wire up the
per-artifact `PORT` and `BASE_PATH` that the dev servers expect.

Each long-running service validates its required environment
variables at startup and fails fast with a single error listing
**every** missing variable, so you can fix a fresh deploy in one
pass instead of restart-by-restart. Variables that gracefully
degrade (Twilio, SendGrid, OpenAI, Stripe, object storage, etc.)
are intentionally NOT required at boot — the services run in a
partially-configured mode so dev / preview environments don't need
every third-party credential.

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
`api-server` into it (so `PENN_ALLOWED_ORIGINS`, `PENN_FULFILLMENT_EMAIL`,
etc. are now read by `resupply-api`). The round-3 consolidation then
folded the former `resupply-worker` process in too (pg-boss boots
in-process at startup), so the env table no longer needs a separate
worker column.

The Task #38 follow-up removed `AUTH_PASSWORD_PEPPER`. Passwords are
hashed with plain argon2id; if you still have an `AUTH_PASSWORD_PEPPER`
secret in your environment from an earlier deploy, it is silently
ignored — feel free to delete it.

| Variable                 | `resupply-api` | Notes                                                                                                                                                                                           |
| ------------------------ | :------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   |       ✅       | HTTP listen port.                                                                                                                                                                               |
| `DATABASE_URL`           |       ✅       | Postgres connection string (v14+). No extensions required. The same connection string is also used by the in-process pg-boss worker (it owns its own pool, distinct from the application pool). |
| `RESUPPLY_LINK_HMAC_KEY` |       ✅       | 32+ random bytes used to sign the short-lived patient links delivered in SMS / email reminders. Generate with `openssl rand -base64 48`. Rotating it invalidates in-flight links.               |

> Migration 0025 stripped pgcrypto column-level PHI encryption and
> dropped the `phone_lookup` table, so the legacy
> `RESUPPLY_MASTER_KEY` / `RESUPPLY_DATA_KEY` / `RESUPPLY_PHONE_HMAC_KEY`
> secrets are no longer read by any code path. Delete them from your
> secrets store if they're still hanging around.

### Optional / feature-gated (degrade gracefully when unset)

| Variable                                                                                             | Used by           | Effect when missing                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`, `LOG_LEVEL`                                                                              | All services      | Defaults to `development` / `info`.                                                                                                                                                                                                                                                                                                                                                        |
| `BASE_PATH`                                                                                          | Vite apps         | Required by every Vite app at config time (the config throws if missing or empty). Set to `/` for root mounts.                                                                                                                                                                                                                                                                             |
| `PENN_ALLOWED_ORIGINS`                                                                               | `resupply-api`    | CORS allowlist for the storefront/fitter routes (the `/api/*` mount). Falls back to Replit dev domain + localhost.                                                                                                                                                                                                                                                                         |
| `RESUPPLY_ALLOWED_ORIGINS`                                                                           | `resupply-api`    | CORS allowlist for the resupply admin/voice routes (the `/resupply-api/*` mount). Falls back to Replit dev domain + localhost.                                                                                                                                                                                                                                                             |
| `SHOP_PUBLIC_BASE_URL`, `REMINDER_PUBLIC_BASE_URL`, `RESUPPLY_VOICE_PUBLIC_BASE_URL`                 | `resupply-api`    | Public base URLs used in outbound deep links. Cart-recovery + reminder emails fall through `SHOP → RESUPPLY_VOICE → https://pennpaps.com` in order.                                                                                                                                                                                                                                        |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | `resupply-api`    | Outbound email + delivery webhooks (used by both the request-handling routes and the in-process worker's reminder jobs). Every sender across the monorepo funnels through the shared `createSendgridClient()` in `lib/resupply-email`, so `SENDGRID_FROM_EMAIL` (set to `info@pennpaps.com`) is the single From address for the entire platform. Email features log-and-skip when missing. |
| `PENN_FULFILLMENT_EMAIL`                                                                             | `resupply-api`    | Where Penn Fit fulfillment receives new mask orders (this is the recipient, not the sender).                                                                                                                                                                                                                                                                                               |
| `RESUPPLY_ADMIN_EMAILS`, `RESUPPLY_AGENT_EMAILS`, `RESUPPLY_OPERATOR_EMAILS`                         | `resupply-api`    | Comma-separated allowlists for role-gated admin endpoints.                                                                                                                                                                                                                                                                                                                                 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`     | `resupply-api`    | SMS + voice. Outbound SMS / voice routes return 503 when missing.                                                                                                                                                                                                                                                                                                                          |
| `OPENAI_API_KEY`                                                                                     | `resupply-api`    | Conversation AI. AI features disable when missing.                                                                                                                                                                                                                                                                                                                                         |
| `STRIPE_SECRET_KEY`                                                                                  | `resupply-api`    | Cash-pay shop checkout + webhooks. Shop endpoints return preview-mode responses when missing.                                                                                                                                                                                                                                                                                              |
| `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`                                                   | `resupply-api`    | Object-storage paths for prescription attachments (used by both the upload routes and the in-process worker's PHI sweep job). The implementation uses `@google-cloud/storage`; in production this points at Replit Object Storage's GCS-compatible API, but any GCS-compatible endpoint works.                                                                                             |
| `VITE_ENABLE_DEMO`, `VITE_RESUPPLY_CONTACT_EMAIL`                                                    | Vite apps         | UI feature flags / display values.                                                                                                                                                                                                                                                                                                                                                         |
| `CODEGEN_OUT_PENNPAPS_CLIENT`, `CODEGEN_OUT_PENNPAPS_ZOD`, `CODEGEN_OUT_RESUPPLY_CLIENT`             | `scripts/codegen` | Override OpenAPI codegen output paths. Defaults are in-repo.                                                                                                                                                                                                                                                                                                                               |
| `REPL_ID`, `REPLIT_DEV_DOMAIN`, `REPLIT_DOMAINS`                                                     | All services      | Set automatically on Replit; usually leave blank locally.                                                                                                                                                                                                                                                                                                                                  |

## Useful scripts

| Command                    | What it does                                                           |
| -------------------------- | ---------------------------------------------------------------------- |
| `pnpm typecheck`           | `tsc --build` across libs + per-app `typecheck`.                       |
| `pnpm build`               | Type-check, then `build` in every package that defines one.            |
| `pnpm lint:resupply`       | ESLint (zero warnings) over the resupply surface.                      |
| `pnpm --filter <pkg> test` | Vitest for a specific package (resupply-api, the resupply-\* libs, …). |

## Privacy contract

Two non-negotiable rules from `replit.md` worth repeating here:

- **Do not add image logging anywhere in the backend.** Camera images
  and video frames never leave the browser; only numeric facial
  measurements are transmitted.
- **Do not log order request bodies in the application logger.** Treat
  every log line as world-readable.
