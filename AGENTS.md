# AGENTS.md

Canonical agent guidance for this repo lives in [`CLAUDE.md`](./CLAUDE.md)
(architecture, hard rules, migrations, deploy contract) and
[`README.md`](./README.md) (setup, env vars, standard commands). Read those
first. This file adds Codex cloud environment notes.

## Codex cloud environment

Configure this repository in Codex cloud with Node 24.x and pnpm 11.7.0.
Use this setup script:

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
```

Store Stripe, SendGrid, Twilio, Supabase, AI vendor, Telnyx, Office Ally,
deployment, and other credentials in Codex environment variables or secrets.
Do not commit `.env` files or generated secrets.

## Project shape

This is a `pnpm` workspaces monorepo with two runnable apps:

- **`@workspace/resupply-api`**: Express API + in-process pg-boss worker
  (serves `/api/*` storefront + `/resupply-api/*` admin/voice). Dev rebuilds
  with esbuild then runs `node dist/index.mjs`; there is no watch / hot reload,
  so restart it after backend changes. Liveness: `/resupply-api/healthz`.
  Readiness: `/resupply-api/readyz` (reports `db` + `queue`).
- **`@workspace/cpap-fitter`**: Vite + React SPA (customer storefront +
  admin console at `/admin/*`).

Standard lint/typecheck/test/build commands are in `README.md` and
`CLAUDE.md`: `pnpm typecheck`, `pnpm lint:resupply`, `pnpm test`, and
`pnpm build`.

## Toolchain

The repo pins `engines.node=24.x` and `pnpm@11.7.0`. If the cloud shell ever
uses Node 22 or native modules such as `argon2` fail with ABI errors, run the
Corepack setup script above again and verify `node --version` reports Node 24.

## Running end-to-end in Codex cloud

The runtime data path is a Supabase project. For isolated development inside
Codex cloud, use the local Supabase stack in the cloud container (Docker +
`supabase` CLI). `supabase/config.toml` is committed and exposes the
`resupply` + `resupply_auth` PostgREST schemas and disables analytics.

1. If `docker info` fails, start Docker in the cloud container:
   `sudo dockerd >/tmp/dockerd.log 2>&1 &` then
   `sudo chmod 666 /var/run/docker.sock`.
2. Bring up + seed the DB (idempotent, about 30s):
   `bash scripts/dev-local-supabase.sh`.
3. `.env` is git-ignored and may contain cloud-only local Supabase defaults.
   Source it into the process env before starting the API:
   `set -a; . ./.env; set +a`.
4. API (port 3000): `pnpm --filter @workspace/resupply-api dev`.
5. SPA (port 5173, proxies to the API):
   `PORT=5173 BASE_PATH=/ API_PROXY_TARGET=http://localhost:3000 pnpm --filter @workspace/cpap-fitter dev`.

Dev admin created by the seed script: `admin@pennpaps.local` /
`PennFitDev123!`; sign in at `http://localhost:5173/admin/sign-in` inside the
cloud browser session.

## Gotchas worth remembering

- PostgREST will not start unless the exposed schemas exist on a fresh DB.
  `supabase/migrations/00000000000000_bootstrap_resupply_schemas.sql`
  pre-creates them so `supabase start` succeeds before app migrations run.
- Sign-in 500 "credentials store" / "permission denied for sequence ..."
  means the Supabase data-API roles lack grants on freshly migrated tables.
  Re-run `scripts/dev-local-supabase.sh`.
- `email_unverified` on sign-in: cloud dev has no SendGrid by default, so
  email verification cannot complete the normal way; the helper stamps
  `email_verified_at` for the dev admin directly.
- Vendor integrations degrade gracefully when their keys are unset. Add keys to
  Codex secrets only when a task needs the integration.
- A fresh cloud container gets an empty Supabase DB, so re-run
  `scripts/dev-local-supabase.sh` after `supabase start` on a clean machine.

## Completion workflow

Before declaring work complete, run the smallest relevant checks first. For most
changes use:

```bash
pnpm typecheck
pnpm lint:resupply
pnpm test
pnpm build
```

If a check cannot run because Docker, Supabase CLI, browser access, or a Codex
secret is missing, state that clearly in the final response.
