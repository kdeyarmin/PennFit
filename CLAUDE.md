# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.
For the full product/architecture overview, see [`replit.md`](./replit.md);
for the human-facing setup guide, see [`README.md`](./README.md).

## Start-of-session checklist

The repo had a ~150-commit drift event in May 2026 across four divergent Git
surfaces. Every session — agent or human — must align to the canonical ref
**before** doing any work:

```bash
git status                                          # 1. confirm clean tree
git fetch subrepl-3ppc2e03                          # 2. fetch canonical
git rev-list --count main..subrepl-3ppc2e03/main    # 3. how far behind?
# If clean and behind, align (destructive — only when status is clean):
git reset --hard subrepl-3ppc2e03/main
```

**Canonical ref:** `main` on `https://github.com/kdeyarmin/PennFit`
(remote-tracking name in Replit: `subrepl-3ppc2e03/main`).

**Where new work lands:** push a feature branch and open a PR on GitHub.
Never commit directly to local `main`. The pre-commit hook prints a
non-blocking warning when `main` is more than 10 commits behind canonical;
bypass with `SKIP_HOOKS=1` only for genuine emergencies.

Post-mortem of the drift event: [`docs/git-state-2026-05-01.md`](./docs/git-state-2026-05-01.md).

## Repository map

This is a `pnpm` workspaces monorepo (Node v24, TypeScript 5.9, pnpm 10.33).

| Path                     | Purpose                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/resupply-api` | Single Express 5 API process. Hosts the storefront/fitter routes (`/api/*`), the resupply admin/voice routes (`/resupply-api/*`), AND the in-process `pg-boss` worker (reminders + PHI sweep) booted from `src/worker/index.ts`. |
| `artifacts/cpap-fitter`  | Customer-facing SPA (Vite + React + Wouter + Tailwind). Mounts the internal admin console at `/admin/*` (gated by `useGetAdminMe`); legacy `/resupply/*` URLs SPA-redirect to `/admin/*` preserving query strings.               |
| `artifacts/shared`       | Cross-artifact static assets (favicons served at root).                                                                                                                                                                          |
| `lib/resupply-*`         | Shared workspace packages: `db`, `auth` (+ `auth-react`), `messaging`, `email`, `ai`, `telecom`, `audit`, `domain`, `secrets`, `reminders`.                                                                                      |
| `lib/api-client-react`   | Generated API client + React hooks.                                                                                                                                                                                              |
| `scripts/`               | Codegen + drift checks (`check-codegen`, `check-drizzle-drift`, `check-resupply-architecture`, `check-resupply-migration-pair`).                                                                                                 |
| `docs/`                  | Architecture notes, post-mortems, production readiness.                                                                                                                                                                          |

There is **one** customer-facing site (`pennfit.replit.app/`). The former
separate `api-server`, `resupply-worker`, and `resupply-dashboard` artifacts
were folded in during the May 2026 consolidations.

## Common commands

```bash
pnpm install                                      # workspace install
pnpm typecheck                                    # tsc --build + per-app typecheck
pnpm build                                        # typecheck, then build everywhere
pnpm lint:resupply                                # ESLint, zero warnings
pnpm --filter <pkg> test                          # Vitest for one package
pnpm --filter @workspace/resupply-api dev         # API + in-process worker
pnpm --filter @workspace/cpap-fitter dev          # storefront + admin SPA
```

In Replit, prefer the registered workflows (`artifacts/resupply-api: Resupply
API` and `artifacts/cpap-fitter: web`) — they wire up the per-artifact
`PORT` and `BASE_PATH` the dev servers expect.

## Hard rules — do not break

These are non-negotiable invariants of the codebase. Treat them as
correctness, not style:

- **No image logging anywhere in the backend.** Camera images and video
  frames never leave the browser; only numeric facial measurements are
  transmitted. Do not add log lines that include image bytes, base64,
  data URLs, or paths to camera-derived blobs.
- **No order request bodies in the application logger.** Treat every log
  line as world-readable. Order payloads contain PHI.
- **No new column-level encryption.** Migration 0025 stripped pgcrypto
  PHI encryption and dropped `phone_lookup`; `RESUPPLY_MASTER_KEY`,
  `RESUPPLY_DATA_KEY`, and `RESUPPLY_PHONE_HMAC_KEY` are no longer read
  by any code path.
- **No password pepper.** Task #38 removed `AUTH_PASSWORD_PEPPER`;
  passwords are hashed with plain argon2id. Stale pepper values in the
  environment are silently ignored.
- **One From address.** Every outbound email funnels through
  `lib/resupply-email`'s `createSendgridClient()`; `SENDGRID_FROM_EMAIL`
  is `info@pennpaps.com`. Don't bypass the shared client.
- **Admin theme stays scoped.** Admin tokens (`--penn-navy`, etc.) live
  in `src/admin.css` under `.admin-root`. Every admin surface must wrap
  its outer `<div>` with `className="admin-root"` so it doesn't clobber
  storefront brand tokens.

## Service boot contract

Long-running services validate required env vars at startup and fail fast
with a single error listing **every** missing variable. Optional / feature-
gated variables (Twilio, SendGrid, OpenAI, Stripe, object storage) degrade
gracefully when unset so dev/preview environments don't need every
third-party credential.

Required at boot for `resupply-api`:

| Variable                 | Notes                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | HTTP listen port.                                                                                                                                        |
| `DATABASE_URL`           | Postgres v14+ (no extensions; only `gen_random_uuid()` is used).                                                                                         |
| `RESUPPLY_LINK_HMAC_KEY` | 32+ random bytes. Signs short-lived patient links in SMS/email reminders. Generate with `openssl rand -base64 48`. Rotation invalidates in-flight links. |

The full env table — including every optional variable and where it's
read — lives in [`README.md`](./README.md#environment-variables) and
[`.env.example`](./.env.example).

## Conventions worth knowing

- **Validation:** Zod at every HTTP boundary in `resupply-api`.
- **DB:** the runtime data path is the **Supabase service-role client**
  exported from `@workspace/resupply-db` as
  `getSupabaseServiceRoleClient()`; every route, worker, and helper
  reads/writes through PostgREST via that client. Drizzle is retained
  ONLY for the migration source-of-truth: the table definitions under
  `lib/resupply-db/src/schema/**` drive `drizzle-kit generate` and
  `lib/resupply-db/scripts/migrate.mjs` applies the SQL via raw `pg`.
  No production runtime path imports `drizzle-orm` or constructs a
  `pg.Pool`. Migration drift is enforced by
  `scripts/check-drizzle-drift.sh`; migration pairs by
  `scripts/check-resupply-migration-pair.sh`. The
  "no direct `pg` outside `lib/resupply-db`" invariant is enforced by
  Rule 7 in `scripts/check-resupply-architecture.sh`.
- **Auth:** in-house, `argon2id` + DB-backed `pf_session` cookies.
  Admin auth flows live under `/admin/sign-in`, `/admin/forgot-password`,
  `/admin/reset-password`, `/admin/verify-email`.
- **Inbound MMS:** webhook downloads each `MediaUrlN` with HTTP basic auth
  (5s/media timeout, 5MB cap, image/\* + application/pdf allowlist, max 10
  attachments/message), uploads to App Storage, persists as
  `message_attachments`. Audit emits counts only — no media URLs, no PHI.
- **Codegen:** OpenAPI clients regenerated by `scripts/codegen`; drift
  checked by `scripts/check-codegen.sh`. Override output paths with
  `CODEGEN_OUT_PENNPAPS_CLIENT`, `CODEGEN_OUT_PENNPAPS_ZOD`,
  `CODEGEN_OUT_RESUPPLY_CLIENT`.

## When in doubt

- For product/architecture questions, read [`replit.md`](./replit.md).
- For env setup, read [`.env.example`](./.env.example) and
  [`README.md`](./README.md).
- For the Git source-of-truth rule, the post-mortem in
  [`docs/git-state-2026-05-01.md`](./docs/git-state-2026-05-01.md)
  explains _why_; follow the start-of-session checklist above to comply.
- For threat-model questions, see [`threat_model.md`](./threat_model.md).
